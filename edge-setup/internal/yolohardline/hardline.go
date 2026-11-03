// Package yolohardline is what a YOLO lease never auto-approves on this host:
// the shared hardline list, the default protections and the organization
// deny-list a lease carries. The rules are data, embedded from hardline.json,
// a byte-identical copy of test/golden/yolo-hardline/hardline.json (the
// contract shared with openedbot's modules/execution/src/domain/yolo-hardline.ts).
//
// The connector applies it to the terminal approvals it answers under a
// lease; the operator installs the same JSON next to the approval plugin,
// which applies it in Python. Same order as openedbot's yolo stage: hardline,
// then the deny-list (an unreadable command is refused), then the
// protections.
package yolohardline

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// JSON is the embedded rule file, installed as-is next to the approval plugin.
//
//go:embed hardline.json
var JSON []byte

type rule struct {
	ID      string `json:"id"`
	Pattern string `json:"pattern"`
}

type document struct {
	Version  int `json:"version"`
	Hardline struct {
		Tools    []string `json:"tools"`
		Paths    []rule   `json:"paths"`
		Commands []rule   `json:"commands"`
	} `json:"hardline"`
	Protect map[string]struct {
		Paths    []string `json:"paths"`
		Commands []string `json:"commands"`
	} `json:"protect"`
	DefaultProtect []string `json:"defaultProtect"`
}

type compiled struct {
	id string
	re *regexp.Regexp
}

type protection struct {
	paths, commands []*regexp.Regexp
}

var (
	hardlineTools    []string
	hardlinePaths    []compiled
	hardlineCommands []compiled
	protections      = map[string]protection{}
	defaultProtect   []string
)

func init() {
	if err := load(JSON); err != nil {
		panic("yolohardline: embedded hardline.json: " + err.Error())
	}
}

func load(data []byte) error {
	var doc document
	if err := json.Unmarshal(data, &doc); err != nil {
		return err
	}
	if doc.Version != 1 || len(doc.DefaultProtect) == 0 {
		return fmt.Errorf("unsupported hardline version %d", doc.Version)
	}
	compile := func(rules []rule) ([]compiled, error) {
		out := make([]compiled, 0, len(rules))
		for _, r := range rules {
			re, err := regexp.Compile(r.Pattern)
			if err != nil {
				return nil, fmt.Errorf("rule %s: %w", r.ID, err)
			}
			out = append(out, compiled{id: r.ID, re: re})
		}
		return out, nil
	}
	var err error
	if hardlinePaths, err = compile(doc.Hardline.Paths); err != nil {
		return err
	}
	if hardlineCommands, err = compile(doc.Hardline.Commands); err != nil {
		return err
	}
	hardlineTools = doc.Hardline.Tools
	for id, p := range doc.Protect {
		var out protection
		for _, pattern := range p.Paths {
			re, err := regexp.Compile(pattern)
			if err != nil {
				return fmt.Errorf("protection %s: %w", id, err)
			}
			out.paths = append(out.paths, re)
		}
		for _, pattern := range p.Commands {
			re, err := regexp.Compile(pattern)
			if err != nil {
				return fmt.Errorf("protection %s: %w", id, err)
			}
			out.commands = append(out.commands, re)
		}
		protections[id] = out
	}
	for _, id := range doc.DefaultProtect {
		if _, ok := protections[id]; !ok {
			return fmt.Errorf("default protection %s has no rules", id)
		}
	}
	defaultProtect = doc.DefaultProtect
	return nil
}

// Subject is what a gate exposes to the checks: the tool key, the paths its
// arguments name, and the command of a terminal gate (HasCommand false when
// the gate runs none).
type Subject struct {
	ToolKey    string
	Paths      []string
	Command    string
	HasCommand bool
}

// Deny is the organization deny-list a lease carries.
type Deny struct {
	Commands []string `json:"commands"`
	Tools    []string `json:"tools"`
	Paths    []string `json:"paths"`
}

// DefaultProtect lists every default protection id; a lease always holds them.
func DefaultProtect() []string { return slices.Clone(defaultProtect) }

// IsProtectionID reports whether id names a protection this host knows.
func IsProtectionID(id string) bool {
	_, ok := protections[id]
	return ok
}

// commandTokenSeparators split a command into the words a path may hide in:
// whitespace, quotes, shell operators and `--flag=value`.
var commandTokenSeparators = strings.NewReplacer("\"", " ", "'", " ", "`", " ", ";", " ", "&", " ", "|", " ", "<", " ", ">", " ", "(", " ", ")", " ", "=", " ")

// Hardline returns the id of the hardline rule the subject hits, "" when none.
//
// The host is stricter than the shared list on one point: a command word that
// is itself a hardline path (`echo x > plugins/ohb_approval_policy/yolo.json`)
// is a hit, so a bot under a lease cannot widen the lease from a terminal. It
// only refuses more, never less.
func Hardline(s Subject) string {
	if s.ToolKey != "" && slices.Contains(hardlineTools, s.ToolKey) {
		return "tool:" + s.ToolKey
	}
	for _, r := range hardlinePaths {
		for _, path := range s.Paths {
			if r.re.MatchString(path) {
				return r.id
			}
		}
	}
	if !s.HasCommand {
		return ""
	}
	for _, r := range hardlineCommands {
		if r.re.MatchString(s.Command) {
			return r.id
		}
	}
	words := strings.Fields(commandTokenSeparators.Replace(s.Command))
	for _, r := range hardlinePaths {
		for _, word := range words {
			if r.re.MatchString(word) {
				return r.id
			}
		}
	}
	return ""
}

// Protection returns the id of the protection the subject hits, among the
// lease's and the defaults (always held), "" when none. An id this host does
// not know protects nothing here: the lease naming it was refused earlier.
func Protection(s Subject, protect []string) string {
	seen := map[string]bool{}
	for _, id := range slices.Concat(defaultProtect, protect) {
		if seen[id] {
			continue
		}
		seen[id] = true
		p, ok := protections[id]
		if !ok {
			continue
		}
		for _, re := range p.paths {
			for _, path := range s.Paths {
				if re.MatchString(path) {
					return id
				}
			}
		}
		if s.HasCommand {
			for _, re := range p.commands {
				if re.MatchString(s.Command) {
					return id
				}
			}
		}
	}
	return ""
}

// DenyHit reports whether the deny-list covers the subject. readable is false
// when a command list exists and the command cannot be read: refused too.
func DenyHit(s Subject, deny Deny) (hit, readable bool) {
	if s.ToolKey != "" && slices.Contains(deny.Tools, s.ToolKey) {
		return true, true
	}
	for _, path := range s.Paths {
		for _, entry := range deny.Paths {
			if DenyPathMatches(path, entry) {
				return true, true
			}
		}
	}
	if s.HasCommand && len(deny.Commands) > 0 {
		matched, ok := CommandMatchesBlocklist(s.Command, deny.Commands)
		return matched || !ok, ok
	}
	return false, true
}

// Block is the verdict of a lease on a gate: "" lets it pass, otherwise the
// reason it is refused (`hardline:<id>`, `denied`, `unreadable`,
// `protected:<id>`).
func Block(s Subject, protect []string, deny Deny) string {
	if id := Hardline(s); id != "" {
		return "hardline:" + id
	}
	if hit, readable := DenyHit(s, deny); hit {
		if !readable {
			return "unreadable"
		}
		return "denied"
	}
	if id := Protection(s, protect); id != "" {
		return "protected:" + id
	}
	return ""
}

func trimSlashes(path string) string {
	if len(path) > 1 {
		return strings.TrimRight(path, "/")
	}
	return path
}

// DenyPathMatches: a deny-list path covers a path when it is it, contains it
// (`/srv/data` covers `/srv/data/x`) or is a run of whole components of it
// (`.aws` covers `~/.aws/config`). Never a substring: `.aws` does not cover
// `my.aws.txt`.
func DenyPathMatches(path, entry string) bool {
	target, denied := trimSlashes(path), trimSlashes(entry)
	if denied == "" {
		return false
	}
	prefix := denied + "/"
	if denied == "/" {
		prefix = "/"
	}
	if target == denied || strings.HasPrefix(target, prefix) {
		return true
	}
	return strings.Contains("/"+target+"/", "/"+strings.TrimLeft(denied, "/")+"/")
}

var (
	segmentSplit = regexp.MustCompile("\\s*(?:&&|\\|\\||[;\\n|]|\\$\\(|`)\\s*")
	assignment   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
)

// CommandMatchesBlocklist: each entry is a command prefix of words (`git push
// --force`); a command matches when one of its segments starts with those
// words, past variable assignments and `sudo`. ok is false when the command
// cannot be read (an unclosed quote).
func CommandMatchesBlocklist(command string, blocklist []string) (matched, ok bool) {
	var patterns [][]string
	for _, entry := range blocklist {
		if words, readable := shellWords(strings.TrimSpace(entry)); readable && len(words) > 0 {
			patterns = append(patterns, words)
		}
	}
	for _, segment := range segmentSplit.Split(command, -1) {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			continue
		}
		words, readable := shellWords(segment)
		if !readable {
			return false, false
		}
		start := 0
		for start < len(words) && assignment.MatchString(words[start]) {
			start++
		}
		if start < len(words) && (words[start] == "sudo" || words[start] == "command") {
			start++
		}
		head := slices.Clone(words[start:])
		if len(head) > 0 {
			head[0] = head[0][strings.LastIndex(head[0], "/")+1:]
		}
		for _, pattern := range patterns {
			if len(pattern) <= len(head) && slices.Equal(pattern, head[:len(pattern)]) {
				return true, true
			}
		}
	}
	return false, true
}

// shellWords splits on spaces and tabs, quotes kept together and removed;
// readable is false on an unclosed quote.
func shellWords(input string) (words []string, readable bool) {
	var current strings.Builder
	var quote rune
	for _, char := range input {
		if quote != 0 {
			if char == quote {
				quote = 0
			} else {
				current.WriteRune(char)
			}
			continue
		}
		switch char {
		case '\'', '"':
			quote = char
		case ' ', '\t':
			if current.Len() > 0 {
				words = append(words, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(char)
		}
	}
	if quote != 0 {
		return nil, false
	}
	if current.Len() > 0 {
		words = append(words, current.String())
	}
	return words, true
}
