package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// priorityOrder is the order hello lists feature names in, spelled out so a
// change to it is a visible contract change: the link feature first, then the
// operator's names from the most to the least essential. When a bound is too
// small for the list, the names at the end are the ones that go.
var priorityOrder = []string{
	"creation_audit_v2",
	"provider_management", "provider_usage", "toolset_management", "mcp_management",
	"mcp_oauth", "gateway_restart",
	"profile_inventory", "profile_management", "profile_capabilities", "profile_credentials", "profile_memory",
	"sessions_inventory",
	"a2a_card", "a2a_audit", "a2a_management",
	"model_context",
	"profile_bundled_skills",
	"mcp_oauth_profile",
	"mcp_profile_disconnect",
	"mcp_live_reload",
	"gateway_graceful_restart",
}

// futureNames are operator features this connector has never heard of: an
// operator newer than the binary reading it.
var futureNames = []string{"future_a", "future_b", "future_c"}

// busiestOperator is every name the operator can announce plus three it has
// not, listed worst-first: unknown names ahead of the known ones, then the
// known ones against the priority. Truncating it in arrival order drops the
// most essential features, which is what the old code did.
func busiestOperator() []string {
	names := append([]string(nil), futureNames...)
	known := append([]string(nil), priorityOrder[1:]...)
	slices.Reverse(known)
	return append(names, known...)
}

// operatorAnnouncing is the operator socket answering GET /capabilities.
func operatorAnnouncing(names ...string) *http.Client {
	body, _ := json.Marshal(map[string]any{"features": names})
	return &http.Client{Transport: readinessTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}}, nil
	})}
}

// sendRaw writes a control frame as literal JSON, so a test pins the bytes on
// the wire and not what Text would encode.
func (b *fakeBroker) sendRaw(t *testing.T, frame string) {
	t.Helper()
	b.mu.Lock()
	c := b.conn
	b.mu.Unlock()
	if err := c.Write(context.Background(), websocket.MessageText, []byte(frame)); err != nil {
		t.Fatal(err)
	}
}

// The incident: 15 operator features plus the link feature already filled the
// 16 slots, and the next operator feature made hello 17 names long, which an
// API at the old bound refuses with 4401. The host must never list more names
// than the bound in force, whatever the operator announces, and the link
// feature must survive a truncation that takes operator features.
func TestHelloNeverListsMoreNamesThanTheDefaultBound(t *testing.T) {
	broker := newBroker(t)
	audit, err := NewCreationAudit(t.TempDir(), "rt-1", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, "", "", nil)
	c.OperatorSocket = "/configured/operator.sock"
	c.operator = operatorAnnouncing(busiestOperator()...)
	c.CreationAudit = audit
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	if want := priorityOrder[:16]; !reflect.DeepEqual(broker.hello.Features, want) {
		t.Fatalf("hello lists %d names %v\nwant the first 16 by priority %v", len(broker.hello.Features), broker.hello.Features, want)
	}
}

// What an API announces in link.context is the bound of the next hello, and
// the last announcement wins: a link.context that announces nothing sends the
// host back to the bound every API accepts.
func TestAnnouncedBoundRaisesTheNextHelloAndTheLastAnnouncementWins(t *testing.T) {
	c := New("", Auth{RuntimeID: "rt-1", LinkToken: "tok"}, "", "", nil)
	c.OperatorSocket = "/configured/operator.sock"
	c.operator = operatorAnnouncing(busiestOperator()...)
	session := func(linkContext string) []string {
		t.Helper()
		broker := newBroker(t)
		c.WSURL = broker.wsURL()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { _ = c.Session(ctx); close(done) }()
		<-broker.ready
		hello := append([]string(nil), broker.hello.Features...)
		broker.sendRaw(t, linkContext)
		// The client reads frames in order: a pong proves link.context was handled.
		broker.send(Text{T: TPing})
		if pong := broker.next(t); pong.T != TPong {
			t.Fatalf("want a pong after link.context, got %+v", pong)
		}
		cancel()
		<-done
		return hello
	}
	announcing := `{"t":"link.context","environment":"prod","ohb":"https://openedbot.app","limits":{"features":64}}`
	silent := `{"t":"link.context","environment":"prod","ohb":"https://openedbot.app"}`

	if got, want := session(announcing), priorityOrder[1:17]; !reflect.DeepEqual(got, want) {
		t.Errorf("before any announcement: hello lists %d names %v, want the 16 of the default bound %v", len(got), got, want)
	}
	if got, want := session(silent), append(slices.Clone(priorityOrder[1:]), futureNames...); !reflect.DeepEqual(got, want) {
		t.Errorf("after limits.features=64: hello lists %d names %v, want all %d in priority order %v", len(got), got, len(want), want)
	}
	if got, want := session(silent), priorityOrder[1:17]; !reflect.DeepEqual(got, want) {
		t.Errorf("after a link.context without limits: hello lists %d names %v, want the default bound again %v", len(got), got, want)
	}
}

// capabilities carries operator features only, in the same order and under the
// same bound as hello.
func TestCapabilitiesFrameKeepsTheBoundAndThePriority(t *testing.T) {
	c := New("", Auth{}, "", "", nil)
	c.OperatorSocket = "/configured/operator.sock"
	c.operator = operatorAnnouncing(busiestOperator()...)
	c.wait = func(context.Context, time.Duration) error { return nil }
	var sent [][]byte
	c.watchOperator(context.Background(), func(_ websocket.MessageType, frame []byte) error {
		sent = append(sent, frame)
		return nil
	})
	if len(sent) != 1 {
		t.Fatalf("watchOperator sent %d frames", len(sent))
	}
	var frame struct {
		T        string   `json:"t"`
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(sent[0], &frame); err != nil {
		t.Fatal(err)
	}
	if want := priorityOrder[1:17]; frame.T != TCapabilities || !reflect.DeepEqual(frame.Features, want) {
		t.Fatalf("capabilities lists %d names %v\nwant the 16 operator names by priority %v", len(frame.Features), frame.Features, want)
	}
}

// The order is a pure function of the names: whatever order the operator lists
// them in, the same ones are kept and dropped, link names first, unknown names
// last.
func TestAnnounceFeaturesOrdersDeduplicatesAndKeepsTheBound(t *testing.T) {
	operator := busiestOperator()
	kept, dropped := announceFeatures(LinkFeatures, operator, DefaultMaxFeatures)
	if want := priorityOrder[:16]; !reflect.DeepEqual(kept, want) {
		t.Fatalf("kept %v\nwant %v", kept, want)
	}
	if want := []string{"model_context", "profile_bundled_skills", "mcp_oauth_profile", "mcp_profile_disconnect", "mcp_live_reload", "gateway_graceful_restart", "future_a", "future_b", "future_c"}; !reflect.DeepEqual(dropped, want) {
		t.Fatalf("dropped %v, want %v (the least essential known names, then unknown ones by name)", dropped, want)
	}

	sorted := slices.Clone(operator)
	slices.Sort(sorted)
	rotated := append(slices.Clone(operator[5:]), operator[:5]...)
	reversed := slices.Clone(operator)
	slices.Reverse(reversed)
	for name, permutation := range map[string][]string{"sorted": sorted, "rotated": rotated, "reversed": reversed} {
		gotKept, gotDropped := announceFeatures(LinkFeatures, permutation, DefaultMaxFeatures)
		if !reflect.DeepEqual(gotKept, kept) || !reflect.DeepEqual(gotDropped, dropped) {
			t.Errorf("%s input changed the outcome: kept %v dropped %v", name, gotKept, gotDropped)
		}
	}

	// A raised bound keeps everything, in the same order.
	if all, none := announceFeatures(LinkFeatures, operator, 64); len(none) != 0 || !reflect.DeepEqual(all, append(slices.Clone(priorityOrder), futureNames...)) {
		t.Errorf("bound 64: kept %v dropped %v", all, none)
	}
	// The link feature is the last to go.
	if only, _ := announceFeatures(LinkFeatures, operator, 1); !reflect.DeepEqual(only, []string{FeatureCreationAuditV2}) {
		t.Errorf("bound 1 kept %v", only)
	}
	// No bound known, or a nonsense one, is the default; a huge one is the ceiling.
	for _, bound := range []int{0, -1} {
		if got, _ := announceFeatures(LinkFeatures, operator, bound); len(got) != DefaultMaxFeatures {
			t.Errorf("bound %d kept %d names, want the default %d", bound, len(got), DefaultMaxFeatures)
		}
	}
	many := make([]string, 100)
	for i := range many {
		many[i] = fmt.Sprintf("feature_%03d", i)
	}
	if got, _ := announceFeatures(nil, many, 1000); len(got) != MaxFeatures {
		t.Errorf("bound 1000 kept %d names, want the ceiling %d", len(got), MaxFeatures)
	}
	// A name listed twice counts once, in its first group; the inputs are left alone.
	link, ops := []string{FeatureCreationAuditV2}, []string{FeatureProviderUsage, FeatureProviderManagement, FeatureProviderUsage, FeatureCreationAuditV2}
	got, none := announceFeatures(link, ops, 16)
	if want := []string{FeatureCreationAuditV2, FeatureProviderManagement, FeatureProviderUsage}; !reflect.DeepEqual(got, want) || none != nil {
		t.Errorf("duplicates: kept %v dropped %v", got, none)
	}
	if !reflect.DeepEqual(ops, []string{FeatureProviderUsage, FeatureProviderManagement, FeatureProviderUsage, FeatureCreationAuditV2}) {
		t.Errorf("the operator list was reordered in place: %v", ops)
	}
	// What was kept can be appended to without touching what was dropped.
	kept, dropped = announceFeatures(LinkFeatures, operator, DefaultMaxFeatures)
	extended := append(kept, "intruder")
	if extended[len(kept)] != "intruder" || dropped[0] != "model_context" {
		t.Errorf("kept and dropped share storage: extended %v, dropped %v", extended, dropped)
	}
}

// A process that restarts starts from the bound the previous one learned: its
// first hello is not cut to the default for as long as one session lasts.
func TestRestoredBoundRulesTheFirstHello(t *testing.T) {
	c := New("", Auth{}, "", "", nil)
	if got := c.FeatureBound(); got != DefaultMaxFeatures {
		t.Fatalf("a new client starts at %d, want %d", got, DefaultMaxFeatures)
	}
	for bound, want := range map[int]int{64: 64, 32: 32, 0: DefaultMaxFeatures, -3: DefaultMaxFeatures, 1000: MaxFeatures} {
		c.SetFeatureBound(bound)
		if got := c.FeatureBound(); got != want {
			t.Errorf("SetFeatureBound(%d): bound %d, want %d", bound, got, want)
		}
	}

	broker := newBroker(t)
	audit, err := NewCreationAudit(t.TempDir(), "rt-1", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	c = New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, "", "", nil)
	c.OperatorSocket = "/configured/operator.sock"
	c.operator = operatorAnnouncing(busiestOperator()...)
	c.CreationAudit = audit
	c.SetFeatureBound(64)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	if want := append(slices.Clone(priorityOrder), futureNames...); !reflect.DeepEqual(broker.hello.Features, want) {
		t.Fatalf("hello lists %d names %v\nwant all %d in priority order %v", len(broker.hello.Features), broker.hello.Features, len(want), want)
	}
}

// A refusal only puts the announced bound in doubt when the refused hello was
// longer than every API accepts.
func TestRelaxFeatureBoundOnlyAfterAHelloAboveTheDefault(t *testing.T) {
	c := New("", Auth{}, "", "", nil)
	c.SetFeatureBound(64)
	c.noteHelloFeatures(DefaultMaxFeatures)
	if listed, relaxed := c.relaxFeatureBound(); relaxed || listed != DefaultMaxFeatures || c.FeatureBound() != 64 {
		t.Fatalf("a hello within the default bound relaxed it: listed=%d relaxed=%v bound=%d", listed, relaxed, c.FeatureBound())
	}
	c.noteHelloFeatures(DefaultMaxFeatures + 1)
	if listed, relaxed := c.relaxFeatureBound(); !relaxed || listed != DefaultMaxFeatures+1 || c.FeatureBound() != DefaultMaxFeatures {
		t.Fatalf("a long hello kept the bound: listed=%d relaxed=%v bound=%d", listed, relaxed, c.FeatureBound())
	}
}

// The rollout this change makes safe, played backwards: a host restored a bound
// of 64, the API behind the name is back at the old bound and closes 4401 on
// the long hello. Without the fallback that is the original outage (ten
// refusals, then one try every 30 minutes); with it the next hello fits.
func TestRefusedLongHelloFallsBackToTheDefaultBound(t *testing.T) {
	var mu sync.Mutex
	var lengths []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-connector.v1"}})
		if err != nil {
			return
		}
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		hello, _ := DecodeText(data)
		mu.Lock()
		lengths = append(lengths, len(hello.Features))
		mu.Unlock()
		if len(hello.Features) > DefaultMaxFeatures {
			// An API at the old bound cannot decode this hello and hangs up.
			_ = conn.Close(websocket.StatusCode(CloseUnauth), "HELLO_REQUIRED")
			return
		}
		frame, _ := EncodeText(Text{T: TLinkContext, Environment: "prod", OHB: "https://openedbot.app"})
		_ = conn.Write(r.Context(), websocket.MessageText, frame)
		// Hold the session until the host hangs up.
		for {
			if _, _, err := conn.Read(r.Context()); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	var logs []string
	c := New("ws"+strings.TrimPrefix(srv.URL, "http"), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, "", "", nil)
	c.OperatorSocket = "/configured/operator.sock"
	c.operator = operatorAnnouncing(busiestOperator()...)
	c.SetFeatureBound(64)
	c.Logf = func(format string, args ...any) {
		mu.Lock()
		logs = append(logs, fmt.Sprintf(format, args...))
		mu.Unlock()
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		count := len(lengths)
		mu.Unlock()
		if count >= 2 {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("the host did not retry after the refusal; hello lengths %v", lengths)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if lengths[0] != len(busiestOperator()) || lengths[1] != DefaultMaxFeatures {
		t.Fatalf("hello lengths %v, want %d then %d", lengths, len(busiestOperator()), DefaultMaxFeatures)
	}
	if !slices.ContainsFunc(logs, func(line string) bool {
		return strings.Contains(line, fmt.Sprintf("hello of %d feature names refused", len(busiestOperator())))
	}) {
		t.Errorf("the fallback was not logged: %q", logs)
	}
}

// Names a bound takes are logged, so a capability missing in openedbot is
// explained by the journal. The line stays short whatever the operator sends.
func TestDroppedFeatureNamesAreLogged(t *testing.T) {
	c := New("", Auth{}, "", "", nil)
	var logs []string
	c.Logf = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }
	c.logDroppedFeatures("hello", 16, nil)
	if len(logs) != 0 {
		t.Fatalf("nothing dropped, yet logged %q", logs)
	}
	c.logDroppedFeatures("hello", 16, []string{"model_context", "future_a"})
	c.logDroppedFeatures("capabilities", 16, []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"})
	want := []string{
		"hello capped at 16 feature names: dropped model_context, future_a",
		"capabilities capped at 16 feature names: dropped a, b, c, d, e, f, g, h and 2 more",
	}
	if !reflect.DeepEqual(logs, want) {
		t.Fatalf("logs %q\nwant %q", logs, want)
	}
}

// The guard behind the 16-name incident: every name the host can announce must
// fit the most hello and capabilities may carry. Hosts that listed 17 names
// were refused by an API that accepted 16, because the host cut the operator's
// list before the link feature joined it and nothing compared the two sides.
// The same vocabulary goes through openedbot's decoder as a golden vector
// (see below), so the API side fails too when the host outgrows the bound it
// accepts.
func TestHostFeatureVocabularyFitsTheBoundTheAPIAccepts(t *testing.T) {
	vocabulary := slices.Concat(LinkFeatures, HostFeatures)
	seen := map[string]bool{}
	for _, name := range vocabulary {
		if !featureRe.MatchString(name) {
			t.Errorf("%q is not a feature name", name)
		}
		if seen[name] {
			t.Errorf("%q is listed twice in LinkFeatures and HostFeatures", name)
		}
		seen[name] = true
	}
	if len(vocabulary) > MaxFeatures {
		t.Fatalf("this host can announce %d feature names, more than the %d a hello may carry. Raise the API first (RELAY_MAX_FEATURES in contracts/connector, announced in link.context), then MaxFeatures here", len(vocabulary), MaxFeatures)
	}
	if MaxFeatures < DefaultMaxFeatures {
		t.Fatalf("MaxFeatures %d is below DefaultMaxFeatures %d", MaxFeatures, DefaultMaxFeatures)
	}
}

// openedbot decodes the same vector, listing every name this host can
// announce (the link's own first, then the operator's by priority). Adding a
// feature changes it on this side; the golden file is then updated in both
// copies, and the API side proves it still accepts the longer list.
func TestGoldenVectorListsEveryFeatureTheHostCanAnnounce(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "test", "golden", "relay-frames", "vectors.json"))
	if err != nil {
		t.Fatalf("missing shared vectors: %v", err)
	}
	var vectors []struct {
		Name  string          `json:"name"`
		Frame json.RawMessage `json:"frame"`
		Valid bool            `json:"valid"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	const name = "hello with every feature name a host can announce"
	for _, v := range vectors {
		if v.Name != name {
			continue
		}
		var hello struct {
			Features []string `json:"features"`
		}
		if err := json.Unmarshal(v.Frame, &hello); err != nil {
			t.Fatal(err)
		}
		want := slices.Concat(LinkFeatures, HostFeatures)
		if !v.Valid || !reflect.DeepEqual(hello.Features, want) {
			encoded, _ := json.Marshal(want)
			t.Fatalf("the shared vector %q is out of date (valid=%v).\nThe host can announce %s\nUpdate it in test/golden/relay-frames/vectors.json and platform/hermes/tests/fixtures/relay-frames.vectors.json, and read the diff as a contract change.", name, v.Valid, encoded)
		}
		return
	}
	t.Fatalf("shared vector %q is missing", name)
}
