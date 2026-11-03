package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

const (
	A2ACardFeature = "a2a_card"
	a2aCardPort    = 9900
	a2aCardPath    = "/.well-known/agent-card.json"
	maxA2ACard     = 32 << 10
	maxA2ASkills   = 64
	maxA2ATags     = 16
)

// A2AAgentCard is the metadata-only operator response. Provider, security,
// tenant, default mode and unknown upstream fields are deliberately omitted.
type A2AAgentCard struct {
	Name                string               `json:"name"`
	Description         string               `json:"description"`
	URL                 string               `json:"url"`
	Version             string               `json:"version"`
	SupportedInterfaces []A2AAgentInterface  `json:"supportedInterfaces"`
	Capabilities        A2AAgentCapabilities `json:"capabilities"`
	Skills              []A2AAgentSkill      `json:"skills"`
}

type A2AAgentInterface struct {
	URL             string `json:"url"`
	ProtocolBinding string `json:"protocolBinding"`
	ProtocolVersion string `json:"protocolVersion"`
}

type A2AAgentCapabilities struct {
	Streaming         bool `json:"streaming"`
	PushNotifications bool `json:"pushNotifications"`
}

type A2AAgentSkill struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

type a2aCardDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type a2aBindProof func(context.Context) error

type a2aCardWire struct {
	Name                string `json:"name"`
	Description         string `json:"description"`
	URL                 string `json:"url"`
	Version             string `json:"version"`
	SupportedInterfaces []struct {
		URL             string `json:"url"`
		ProtocolBinding string `json:"protocolBinding"`
		ProtocolVersion string `json:"protocolVersion"`
	} `json:"supportedInterfaces"`
	Capabilities *struct {
		Streaming         bool `json:"streaming"`
		PushNotifications bool `json:"pushNotifications"`
	} `json:"capabilities"`
	Skills []struct {
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Tags        []string `json:"tags"`
	} `json:"skills"`
}

var a2aCardHTTPClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: time.Second}).DialContext,
		MaxConnsPerHost:       1,
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: time.Second,
	},
	Timeout: time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

func (s *Server) a2aAgentCard(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeError(w, http.StatusBadRequest, "A2A_INPUT_INVALID", "the Agent Card read accepts no query parameters")
		return
	}
	if s.A2ACard == nil {
		writeError(w, http.StatusServiceUnavailable, "A2A_CARD_UNAVAILABLE", "the local A2A Agent Card is unavailable")
		return
	}
	card, err := s.A2ACard(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "A2A_CARD_UNAVAILABLE", "the local A2A Agent Card is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, card)
}

func readLoopbackA2ACard(ctx context.Context, runner exec.Runner) (A2AAgentCard, error) {
	return fetchA2ACard(ctx, a2aCardHTTPClient, func(ctx context.Context) error {
		return proveA2ALoopbackListener(ctx, runner)
	})
}

func fetchA2ACard(ctx context.Context, doer a2aCardDoer, proveBind a2aBindProof) (A2AAgentCard, error) {
	if doer == nil || proveBind == nil {
		return A2AAgentCard{}, errors.New("A2A card reader dependencies are unavailable")
	}
	if err := proveBind(ctx); err != nil {
		return A2AAgentCard{}, errors.New("A2A listener is not proven loopback-only")
	}
	endpoint := "http://127.0.0.1:" + strconv.Itoa(a2aCardPort) + a2aCardPath
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return A2AAgentCard{}, errors.New("A2A card request could not be constructed")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := doer.Do(req)
	if err != nil {
		return A2AAgentCard{}, errors.New("A2A card loopback request failed")
	}
	if resp == nil || resp.Body == nil {
		return A2AAgentCard{}, errors.New("A2A card response is missing")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return A2AAgentCard{}, errors.New("A2A card endpoint did not return HTTP 200")
	}
	mediaType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return A2AAgentCard{}, errors.New("A2A card response is not JSON")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxA2ACard+1))
	if err != nil || len(body) > maxA2ACard {
		return A2AAgentCard{}, errors.New("A2A card response exceeds its size bound")
	}
	card, err := parseA2ACard(body)
	if err != nil {
		return A2AAgentCard{}, errors.New("A2A card metadata failed validation")
	}
	if err := proveBind(ctx); err != nil {
		return A2AAgentCard{}, errors.New("A2A listener changed or is not proven loopback-only")
	}
	return card, nil
}

func parseA2ACard(body []byte) (A2AAgentCard, error) {
	if len(body) == 0 || len(body) > maxA2ACard || !utf8.Valid(body) {
		return A2AAgentCard{}, errors.New("A2A card size or encoding is invalid")
	}
	if err := rejectDuplicateJSONKeys(body); err != nil {
		return A2AAgentCard{}, errors.New("A2A card JSON is ambiguous")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	var wire a2aCardWire
	if err := decoder.Decode(&wire); err != nil {
		return A2AAgentCard{}, errors.New("A2A card JSON is invalid")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return A2AAgentCard{}, errors.New("A2A card has trailing JSON")
	}

	name, err := boundedA2AText(wire.Name, 120, true)
	if err != nil {
		return A2AAgentCard{}, err
	}
	description, err := boundedA2AText(wire.Description, 512, false)
	if err != nil {
		return A2AAgentCard{}, err
	}
	cardURL, err := boundedA2AURL(wire.URL)
	if err != nil {
		return A2AAgentCard{}, err
	}
	version, err := boundedA2AText(wire.Version, 64, true)
	if err != nil {
		return A2AAgentCard{}, err
	}
	if len(wire.SupportedInterfaces) == 0 || len(wire.SupportedInterfaces) > 8 {
		return A2AAgentCard{}, errors.New("A2A card interfaces are missing or exceed their bound")
	}
	interfaces := make([]A2AAgentInterface, 0, len(wire.SupportedInterfaces))
	for _, input := range wire.SupportedInterfaces {
		ifaceURL, err := boundedA2AURL(input.URL)
		if err != nil {
			return A2AAgentCard{}, err
		}
		binding, err := boundedA2AText(input.ProtocolBinding, 24, true)
		if err != nil || binding != "JSONRPC" {
			return A2AAgentCard{}, errors.New("A2A card protocol binding is unsupported")
		}
		protocolVersion, err := boundedA2AText(input.ProtocolVersion, 16, true)
		if err != nil || (protocolVersion != "1.0" && protocolVersion != "1.0.0") {
			return A2AAgentCard{}, errors.New("A2A card protocol version is unsupported")
		}
		interfaces = append(interfaces, A2AAgentInterface{URL: ifaceURL, ProtocolBinding: binding, ProtocolVersion: protocolVersion})
	}
	if len(wire.Skills) > maxA2ASkills {
		return A2AAgentCard{}, errors.New("A2A card skills exceed their bound")
	}
	skills := make([]A2AAgentSkill, 0, len(wire.Skills))
	for _, input := range wire.Skills {
		id, err := boundedA2AText(input.ID, 96, true)
		if err != nil {
			return A2AAgentCard{}, err
		}
		skillName, err := boundedA2AText(input.Name, 96, true)
		if err != nil {
			return A2AAgentCard{}, err
		}
		skillDescription, err := boundedA2AText(input.Description, 256, false)
		if err != nil {
			return A2AAgentCard{}, err
		}
		if len(input.Tags) > maxA2ATags {
			return A2AAgentCard{}, errors.New("A2A card skill tags exceed their bound")
		}
		tags := make([]string, 0, len(input.Tags))
		for _, inputTag := range input.Tags {
			tag, err := boundedA2AText(inputTag, 64, true)
			if err != nil {
				return A2AAgentCard{}, err
			}
			tags = append(tags, tag)
		}
		skills = append(skills, A2AAgentSkill{ID: id, Name: skillName, Description: skillDescription, Tags: tags})
	}
	capabilities := A2AAgentCapabilities{}
	if wire.Capabilities != nil {
		capabilities.Streaming = wire.Capabilities.Streaming
		capabilities.PushNotifications = wire.Capabilities.PushNotifications
	}
	return A2AAgentCard{Name: name, Description: description, URL: cardURL, Version: version,
		SupportedInterfaces: interfaces, Capabilities: capabilities, Skills: skills}, nil
}

func rejectDuplicateJSONKeys(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := walkUniqueJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("JSON has trailing data")
	}
	return nil
}

func walkUniqueJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is invalid")
			}
			if _, exists := seen[key]; exists {
				return errors.New("JSON object contains a duplicate key")
			}
			seen[key] = struct{}{}
			if err := walkUniqueJSONValue(decoder); err != nil {
				return err
			}
		}
		close, err := decoder.Token()
		if err != nil || close != json.Delim('}') {
			return errors.New("JSON object is not closed")
		}
	case '[':
		for decoder.More() {
			if err := walkUniqueJSONValue(decoder); err != nil {
				return err
			}
		}
		close, err := decoder.Token()
		if err != nil || close != json.Delim(']') {
			return errors.New("JSON array is not closed")
		}
	default:
		return errors.New("JSON delimiter is invalid")
	}
	return nil
}

func boundedA2AText(value string, maxBytes int, required bool) (string, error) {
	if !utf8.ValidString(value) {
		return "", errors.New("A2A card text is not valid UTF-8")
	}
	value = strings.TrimSpace(value)
	if len(value) > maxBytes || (required && value == "") {
		return "", errors.New("A2A card text is empty or exceeds its bound")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", errors.New("A2A card text contains a control character")
		}
	}
	return value, nil
}

func boundedA2AURL(value string) (string, error) {
	text, err := boundedA2AText(value, 512, true)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(text)
	if err != nil || !u.IsAbs() || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("A2A card URL is invalid")
	}
	return u.String(), nil
}
