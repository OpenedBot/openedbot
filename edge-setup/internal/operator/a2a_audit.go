package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const (
	a2aAuditSource        = "a2a_audit"
	a2aPolicyProbeSource  = "operator.policy_probe"
	a2aPolicyGuardSource  = "operator.policy_guard"
	a2aPolicyDenialSource = "policy_denials"
	a2aPolicyDenialFile   = "policy_denials.jsonl"
	a2aAuditFile          = "a2a_audit.jsonl"
	defaultA2AAuditLimit  = 50
	maxA2AAuditLimit      = 100
	maxA2AAuditBytes      = 512 << 10
	maxA2AAuditLineBytes  = 8 << 10
	maxA2AAuditQueryBytes = 32
)

var (
	a2aAuditPeerPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@_-]{0,127}$`)
	a2aAuditTaskPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	a2aPolicyTaskPattern = regexp.MustCompile(`^task-[a-f0-9]{16}$`)
)

type a2aAuditRecord struct {
	ID        string  `json:"id"`
	Source    string  `json:"source"`
	TS        float64 `json:"ts"`
	Direction string  `json:"direction"`
	Peer      string  `json:"peer,omitempty"`
	TaskID    string  `json:"taskId,omitempty"`
}

type a2aAuditSnapshot struct {
	Status         string           `json:"status"`
	Source         string           `json:"source"`
	Limit          int              `json:"limit"`
	Truncated      bool             `json:"truncated"`
	SkippedRecords int              `json:"skippedRecords,omitempty"`
	Records        []a2aAuditRecord `json:"records"`
}

type a2aAuditWireRecord struct {
	TS        float64 `json:"ts"`
	Direction string  `json:"direction"`
	Peer      string  `json:"peer"`
	TaskID    string  `json:"task_id"`
	Summary   string  `json:"summary"`
	Source    string  `json:"source"`
}

type a2aPolicyProbeReceipt struct {
	TS        float64 `json:"ts"`
	Direction string  `json:"direction"`
	Peer      string  `json:"peer"`
	TaskID    string  `json:"task_id"`
	Summary   string  `json:"summary"`
	Source    string  `json:"source"`
}

type a2aAuditReader func(context.Context, int) (a2aAuditSnapshot, error)

// newA2AAuditHandler keeps the storage location outside the request surface.
// Host wiring injects a reader bound to its configured Hermes home.
func newA2AAuditHandler(read a2aAuditReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, http.StatusMethodNotAllowed, "A2A_AUDIT_METHOD_INVALID", "the A2A audit supports GET only")
			return
		}
		limit, err := parseA2AAuditLimit(r.URL.RawQuery)
		if err != nil {
			writeError(w, http.StatusBadRequest, "A2A_AUDIT_INPUT_INVALID", "the A2A audit query is invalid")
			return
		}
		if read == nil {
			writeError(w, http.StatusServiceUnavailable, "A2A_AUDIT_UNAVAILABLE", "the local A2A audit is unavailable")
			return
		}
		snapshot, err := read(r.Context(), limit)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "A2A_AUDIT_UNAVAILABLE", "the local A2A audit is unavailable")
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	}
}

func parseA2AAuditLimit(rawQuery string) (int, error) {
	if len(rawQuery) > maxA2AAuditQueryBytes {
		return 0, errors.New("A2A audit query is too long")
	}
	if rawQuery == "" {
		return defaultA2AAuditLimit, nil
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil || len(values) != 1 {
		return 0, errors.New("invalid A2A audit query")
	}
	limitValues, ok := values["limit"]
	if !ok || len(limitValues) != 1 || limitValues[0] == "" {
		return 0, errors.New("invalid A2A audit limit")
	}
	limit, err := strconv.Atoi(limitValues[0])
	if err != nil || limit < 1 || limit > maxA2AAuditLimit {
		return 0, errors.New("A2A audit limit is out of range")
	}
	return limit, nil
}

// readA2AAuditTail reads only a bounded suffix from the fixed upstream JSONL
// file. The configured Hermes home is supplied by host wiring, never by HTTP.
func readA2AAuditTail(ctx context.Context, hermesHome string, limit int) (a2aAuditSnapshot, error) {
	return readA2AAuditFileTail(ctx, hermesHome, limit, a2aAuditSource)
}

// The collection keeps its original envelope name. Each record identifies
// its fixed append file separately so equal offsets cannot collide.
func readA2AAuditWithPolicyDenials(ctx context.Context, hermesHome string, limit int) (a2aAuditSnapshot, error) {
	upstream, err := readA2AAuditFileTail(ctx, hermesHome, limit, a2aAuditSource)
	if err != nil {
		return a2aAuditSnapshot{}, err
	}
	denials, err := readA2AAuditFileTail(ctx, hermesHome, limit, a2aPolicyDenialSource)
	if err != nil {
		return a2aAuditSnapshot{}, err
	}
	if upstream.Status == "missing" && denials.Status == "missing" {
		return emptyA2AAuditSnapshot("missing", limit), nil
	}
	result := emptyA2AAuditSnapshot("available", limit)
	result.Truncated = upstream.Truncated || denials.Truncated
	result.SkippedRecords = upstream.SkippedRecords + denials.SkippedRecords
	result.Records = append(upstream.Records, denials.Records...)
	sort.Slice(result.Records, func(i, j int) bool {
		a, b := result.Records[i], result.Records[j]
		if a.TS != b.TS {
			return a.TS < b.TS
		}
		aFile, aOffset, _ := strings.Cut(a.ID, ":")
		bFile, bOffset, _ := strings.Cut(b.ID, ":")
		if aFile != bFile {
			return aFile < bFile
		}
		aNumber, _ := strconv.ParseInt(aOffset, 10, 64)
		bNumber, _ := strconv.ParseInt(bOffset, 10, 64)
		return aNumber < bNumber
	})
	if len(result.Records) > limit {
		result.Records = result.Records[len(result.Records)-limit:]
		result.Truncated = true
	}
	if result.Truncated {
		result.Status = "truncated"
	}
	return result, nil
}

func readA2AAuditFileTail(ctx context.Context, hermesHome string, limit int, sourceFile string) (a2aAuditSnapshot, error) {
	if ctx == nil || ctx.Err() != nil {
		return a2aAuditSnapshot{}, errors.New("A2A audit read was canceled")
	}
	if limit < 1 || limit > maxA2AAuditLimit || !filepath.IsAbs(hermesHome) {
		return a2aAuditSnapshot{}, errors.New("A2A audit configuration is invalid")
	}
	hermesHome = filepath.Clean(hermesHome)
	rootInfo, err := os.Lstat(hermesHome)
	if errors.Is(err, os.ErrNotExist) {
		return emptyA2AAuditSnapshot("missing", limit), nil
	}
	if err != nil || rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return a2aAuditSnapshot{}, errors.New("A2A audit root is unavailable")
	}

	fileName := a2aAuditFile
	if sourceFile == a2aPolicyDenialSource {
		fileName = a2aPolicyDenialFile
	} else if sourceFile != a2aAuditSource {
		return a2aAuditSnapshot{}, errors.New("A2A audit source is invalid")
	}
	path := filepath.Join(hermesHome, fileName)
	pathInfo, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyA2AAuditSnapshot("missing", limit), nil
	}
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
		return a2aAuditSnapshot{}, errors.New("A2A audit file is unavailable")
	}
	if sourceFile == a2aPolicyDenialSource {
		rootState, rootErr := fsx.Lstat(hermesHome)
		if rootErr != nil {
			return a2aAuditSnapshot{}, errors.New("A2A audit root is unavailable")
		}
		if _, err := fsx.RequireRegular(path, 0o600, rootState.Owner); err != nil {
			return a2aAuditSnapshot{}, errors.New("A2A policy denial file is unsafe")
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return a2aAuditSnapshot{}, errors.New("A2A audit file is unavailable")
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openedInfo) {
		return a2aAuditSnapshot{}, errors.New("A2A audit file changed during read")
	}
	if openedInfo.Size() < 0 {
		return a2aAuditSnapshot{}, errors.New("A2A audit size is invalid")
	}

	start := int64(0)
	truncated := false
	if openedInfo.Size() > maxA2AAuditBytes {
		start = openedInfo.Size() - maxA2AAuditBytes
		truncated = true
	}
	data := make([]byte, int(openedInfo.Size()-start))
	if len(data) > 0 {
		if _, err := io.ReadFull(io.NewSectionReader(file, start, int64(len(data))), data); err != nil {
			return a2aAuditSnapshot{}, errors.New("A2A audit suffix could not be read")
		}
	}

	baseOffset := start
	if start > 0 {
		previous := []byte{0}
		if _, err := file.ReadAt(previous, start-1); err != nil {
			return a2aAuditSnapshot{}, errors.New("A2A audit boundary could not be read")
		}
		if previous[0] != '\n' {
			separator := bytes.IndexByte(data, '\n')
			if separator < 0 {
				return a2aAuditSnapshot{
					Status: "truncated", Source: a2aAuditSource, Limit: limit,
					Truncated: true, SkippedRecords: 1, Records: []a2aAuditRecord{},
				}, nil
			}
			baseOffset += int64(separator + 1)
			data = data[separator+1:]
		}
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		lastNewline := bytes.LastIndexByte(data, '\n')
		if lastNewline < 0 {
			return a2aAuditSnapshot{
				Status: "truncated", Source: a2aAuditSource, Limit: limit,
				Truncated: true, SkippedRecords: 1, Records: []a2aAuditRecord{},
			}, nil
		}
		data = data[:lastNewline+1]
		truncated = true
	}

	result := emptyA2AAuditSnapshot("available", limit)
	result.Truncated = truncated
	for len(data) > 0 {
		lineEnd := bytes.IndexByte(data, '\n')
		if lineEnd < 0 {
			break
		}
		line := data[:lineEnd]
		lineOffset := baseOffset
		baseOffset += int64(lineEnd + 1)
		data = data[lineEnd+1:]
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		if len(line) > maxA2AAuditLineBytes {
			result.SkippedRecords++
			continue
		}
		record, valid := parseA2AAuditRecordFromFile(line, lineOffset, sourceFile)
		if !valid {
			result.SkippedRecords++
			continue
		}
		result.Records = append(result.Records, record)
		if len(result.Records) > limit {
			copy(result.Records, result.Records[len(result.Records)-limit:])
			result.Records = result.Records[:limit]
		}
	}
	if result.Truncated {
		result.Status = "truncated"
	}
	return result, nil
}

func parseA2AAuditRecord(line []byte, offset int64) (a2aAuditRecord, bool) {
	return parseA2AAuditRecordFromFile(line, offset, a2aAuditSource)
}

func parseA2AAuditRecordFromFile(line []byte, offset int64, sourceFile string) (a2aAuditRecord, bool) {
	var wire a2aAuditWireRecord
	if len(line) == 0 || rejectDuplicateJSONKeys(line) != nil || json.Unmarshal(line, &wire) != nil {
		return a2aAuditRecord{}, false
	}
	if math.IsNaN(wire.TS) || math.IsInf(wire.TS, 0) || wire.TS <= 0 || wire.TS >= 253402300800 {
		return a2aAuditRecord{}, false
	}
	if wire.TaskID != "" && !a2aAuditTaskPattern.MatchString(wire.TaskID) {
		return a2aAuditRecord{}, false
	}
	origin := "upstream"
	if wire.Source != "" {
		if wire.Source != "upstream" && wire.Source != a2aPolicyProbeSource && wire.Source != a2aPolicyGuardSource {
			return a2aAuditRecord{}, false
		}
		origin = wire.Source
	}
	if sourceFile == a2aPolicyDenialSource {
		if origin != a2aPolicyGuardSource || wire.Direction != "denied" || wire.Peer == "" || wire.Summary != "" || (wire.TaskID != "" && !a2aPolicyTaskPattern.MatchString(wire.TaskID)) {
			return a2aAuditRecord{}, false
		}
	} else if sourceFile != a2aAuditSource || origin == a2aPolicyGuardSource {
		return a2aAuditRecord{}, false
	}
	switch wire.Direction {
	case "inbound", "outbound", "push":
		if origin != "upstream" {
			return a2aAuditRecord{}, false
		}
	case "denied":
		if (origin != a2aPolicyProbeSource && origin != a2aPolicyGuardSource) || (origin == a2aPolicyProbeSource && !a2aPolicyTaskPattern.MatchString(wire.TaskID)) || wire.Peer == "" || wire.Summary != "" {
			return a2aAuditRecord{}, false
		}
	default:
		return a2aAuditRecord{}, false
	}
	peer := ""
	if a2aAuditPeerPattern.MatchString(wire.Peer) {
		peer = wire.Peer
	}
	if wire.Peer != "" && peer == "" {
		return a2aAuditRecord{}, false
	}
	return a2aAuditRecord{
		ID: fmt.Sprintf("%s:%d", sourceFile, offset), Source: origin,
		TS: wire.TS, Direction: wire.Direction, Peer: peer, TaskID: wire.TaskID,
	}, true
}

// appendA2APolicyProbeReceipt writes only a host-created denial receipt. It
// accepts no summary or arbitrary record fields from a caller.
func appendA2APolicyProbeReceipt(hermesHome, peer, taskID string) error {
	if !filepath.IsAbs(hermesHome) || !a2aAuditPeerPattern.MatchString(peer) || !a2aPolicyTaskPattern.MatchString(taskID) {
		return errors.New("A2A policy receipt metadata is invalid")
	}
	hermesHome = filepath.Clean(hermesHome)
	rootInfo, err := fsx.Lstat(hermesHome)
	if err != nil || !rootInfo.Exists || rootInfo.Symlink || !rootInfo.Dir ||
		rootInfo.Owner.UID < 0 || rootInfo.Owner.GID < 0 {
		return errors.New("A2A audit root is unavailable")
	}
	path := filepath.Join(hermesHome, a2aAuditFile)
	pathInfo, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("A2A audit file is unavailable")
	}
	created := errors.Is(err, os.ErrNotExist)
	if !created && (pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular()) {
		return errors.New("A2A audit file is unavailable")
	}
	flags := os.O_RDWR | os.O_APPEND
	if created {
		flags |= os.O_CREATE | os.O_EXCL
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return errors.New("A2A audit file is unavailable")
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() {
		return errors.New("A2A audit file is unavailable")
	}
	pathInfo, err = os.Lstat(path)
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(openedInfo, pathInfo) {
		return errors.New("A2A audit file changed during write")
	}
	if created {
		removeCreatedFile := func() {
			opened, statErr := file.Stat()
			current, lstatErr := os.Lstat(path)
			if statErr == nil && lstatErr == nil && os.SameFile(opened, current) {
				_ = os.Remove(path)
			}
		}
		if err := file.Chown(rootInfo.Owner.UID, rootInfo.Owner.GID); err != nil {
			removeCreatedFile()
			return errors.New("A2A audit file owner could not be set")
		}
		if err := file.Chmod(0o600); err != nil {
			removeCreatedFile()
			return errors.New("A2A audit file mode could not be set")
		}
		openedInfo, err = file.Stat()
		if err != nil || !openedInfo.Mode().IsRegular() || openedInfo.Mode().Perm() != 0o600 {
			removeCreatedFile()
			return errors.New("A2A audit file permissions are unsafe")
		}
		pathInfo, err = os.Lstat(path)
		fileState, stateErr := fsx.Lstat(path)
		if err != nil || stateErr != nil || !fileState.Exists || fileState.Symlink ||
			!fileState.Regular || fileState.Mode != 0o600 || fileState.Owner != rootInfo.Owner ||
			pathInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(openedInfo, pathInfo) {
			removeCreatedFile()
			return errors.New("A2A audit file owner or permissions are unsafe")
		}
	}
	receipt := a2aPolicyProbeReceipt{
		TS: float64(time.Now().UnixNano()) / float64(time.Second), Direction: "denied",
		Peer: peer, TaskID: taskID, Summary: "", Source: a2aPolicyProbeSource,
	}
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return errors.New("A2A policy receipt could not be encoded")
	}
	encoded = append(encoded, '\n')
	if openedInfo.Size() > 0 {
		last := []byte{0}
		if _, err := file.ReadAt(last, openedInfo.Size()-1); err != nil {
			return errors.New("A2A audit append boundary could not be read")
		}
		if last[0] != '\n' {
			encoded = append([]byte{'\n'}, encoded...)
		}
	}
	written, err := file.Write(encoded)
	if err != nil || written != len(encoded) {
		return errors.New("A2A policy receipt could not be appended")
	}
	if err := file.Sync(); err != nil {
		return errors.New("A2A policy receipt could not be synchronized")
	}
	return nil
}

func emptyA2AAuditSnapshot(status string, limit int) a2aAuditSnapshot {
	return a2aAuditSnapshot{
		Status: status, Source: a2aAuditSource, Limit: limit, Records: []a2aAuditRecord{},
	}
}
