// Package docs holds no code: it carries the test that keeps docs/*.md and
// the pages of the public documentation site (docs/ at the root of the
// OpenedBot/openedbot monorepo) from drifting apart.
package docs

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
)

// siteEnv overrides where the documentation site is checked out. By default it
// is docs/ at the root of the monorepo.
const siteEnv = "OPENEDBOT_DOCS_DIR"

// sitePages returns the directory of the site's /docs pages. A missing site
// fails the test instead of skipping it: the mirror is a contract, and a CI
// job that forgot the checkout must not pass silently.
func sitePages(t *testing.T) string {
	t.Helper()
	root := os.Getenv(siteEnv)
	if root == "" {
		root = filepath.Join("..", "..", "..", "docs")
	}
	// The site is bilingual: English at the root, French under fr/. docs/
	// here is French, so the mirror is the French page.
	dir := filepath.Join(root, "src", "content", "docs", "fr", "docs")
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("documentation site not found at %s: expected docs/ at the root of OpenedBot/openedbot, or set %s", dir, siteEnv)
	}
	return dir
}

// mirrored maps a document of docs/ to the page that reproduces it.
// CONNECTOR.md, PROXMOX_LXC.md, PROVENANCE.md and HISTORY-tailnet.md stay in
// this repo only: the site has no page for them (its prerequisites page carries
// the two LXC facts an operator needs, in its own words).
var mirrored = map[string]string{
	"OPERATIONS.md": "operations.mdx",
	"RESET.md":      "reset.mdx",
}

// codeBlocks returns every fenced block of a document, normalised. Prose is
// deliberately not compared: the site rewrites headings and links. Commands
// are what an operator copies, and a command that changed on one side only
// is the drift that hurts.
func codeBlocks(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var blocks []string
	var cur []string
	in := false
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "```") {
			if in {
				blocks = append(blocks, strings.TrimSpace(strings.Join(cur, "\n")))
				cur = nil
			}
			in = !in
			continue
		}
		if in {
			// Column alignment is cosmetic: the site pads its tables
			// differently. Collapse runs of blanks so a command is compared
			// on what it does, not on how it is laid out.
			cur = append(cur, strings.Join(strings.Fields(line), " "))
		}
	}
	return blocks
}

// TestSiteMirrorsTheDocs fails when a command exists in docs/ but not in the
// page that mirrors it, or the other way round. The two copies are written
// by hand; without this, editing one of them silently publishes a command
// nobody can run.
func TestSiteMirrorsTheDocs(t *testing.T) {
	for doc, page := range mirrored {
		docPath := filepath.Join("..", "..", "docs", doc)
		pagePath := filepath.Join(sitePages(t), page)
		if _, err := os.Stat(pagePath); err != nil {
			t.Errorf("%s has no page at %s", doc, pagePath)
			continue
		}
		inDoc := map[string]bool{}
		for _, b := range codeBlocks(t, docPath) {
			inDoc[b] = true
		}
		inPage := map[string]bool{}
		for _, b := range codeBlocks(t, pagePath) {
			inPage[b] = true
		}
		for b := range inDoc {
			if !inPage[b] {
				t.Errorf("docs/%s has a block missing from the site page %s:\n%s", doc, page, indent(b))
			}
		}
		for b := range inPage {
			if !inDoc[b] {
				t.Errorf("the site page %s has a block missing from docs/%s:\n%s", page, doc, indent(b))
			}
		}
	}
}

func indent(s string) string {
	return "\t" + strings.ReplaceAll(s, "\n", "\n\t")
}

// readMirror returns the source of a mirrored document and of its page.
func readMirror(t *testing.T, doc string) (docSrc, pageSrc string) {
	t.Helper()
	d, err := os.ReadFile(filepath.Join("..", "..", "docs", doc))
	if err != nil {
		t.Fatal(err)
	}
	p, err := os.ReadFile(filepath.Join(sitePages(t), mirrored[doc]))
	if err != nil {
		t.Fatal(err)
	}
	return string(d), string(p)
}

// steppedDocs lists the mirrored documents whose numbered steps are also
// compared span by span. A document joins it once its page is in step; both
// sides must then keep the steps in the same order.
var steppedDocs = []string{"RESET.md", "OPERATIONS.md"}

// sectionedDocs lists the mirrored documents whose sections are also compared
// span by span. OPERATIONS.md is tables and prose around one short numbered
// list, so its steps alone leave most of it unwatched: its page lost the
// details of three option rows, a reboot check and half of the automatic-upgrade
// proof while every fenced block still matched. RESET.md is in it too: its
// intro, its `uninstall` section and its rebuild section sit outside the
// numbered removal order. A document joins it once its page is in step, under
// the same headings.
var sectionedDocs = []string{"RESET.md", "OPERATIONS.md"}

var (
	// numberedStep matches the first line of a list item such as "7. text".
	numberedStep = regexp.MustCompile(`^\d+\.\s+(.*)$`)
	// codeSpan matches an inline code span: one backtick on each side, or two
	// when the span itself holds a backtick.
	codeSpan = regexp.MustCompile("``(.+?)``|`([^`]+)`")
	// siblingDoc matches a bare Markdown file name such as `OPERATIONS.md`.
	// The site turns such a cross-reference into a link, so it is not compared.
	siblingDoc = regexp.MustCompile(`^[A-Za-z0-9_-]+\.md$`)
	// sectionHeading matches a Markdown heading of level 2 to 6. The level-1
	// title is no section: the page carries it in its front matter.
	sectionHeading = regexp.MustCompile(`^#{2,6}\s+(\S.*)$`)
)

// stepTexts returns the text of each numbered list item of a Markdown or MDX
// source, in order, with its lines folded into one. Fenced blocks are left out
// (codeBlocks compares them), and a paragraph that follows the list after a
// blank line is not part of the last item.
func stepTexts(src string) []string {
	var steps []string
	fenced, open, blank := false, false, false
	for _, line := range strings.Split(src, "\n") {
		text := strings.TrimSpace(line)
		indented := strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")
		if strings.HasPrefix(text, "```") {
			fenced = !fenced
			open = open && indented
			continue
		}
		if fenced {
			continue
		}
		if m := numberedStep.FindStringSubmatch(line); m != nil {
			steps = append(steps, m[1])
			open, blank = true, false
			continue
		}
		switch {
		case text == "":
			blank = true
		case open && (strings.HasPrefix(line, "#") || (blank && !indented)):
			open = false
		case open:
			steps[len(steps)-1] += " " + text
			blank = false
		}
	}
	return steps
}

// spansOf returns the inline code spans a text names: the paths, units and
// flags an operator copies. Whitespace inside a span is collapsed, so a span
// wrapped over two lines still matches.
func spansOf(text string) map[string]bool {
	spans := map[string]bool{}
	for _, m := range codeSpan.FindAllStringSubmatch(text, -1) {
		if s := strings.Join(strings.Fields(m[1]+m[2]), " "); s != "" && !siblingDoc.MatchString(s) {
			spans[s] = true
		}
	}
	return spans
}

// stepSpans returns, for each numbered step of a source, the inline code spans
// it names.
func stepSpans(src string) []map[string]bool {
	var out []map[string]bool
	for _, text := range stepTexts(src) {
		out = append(out, spansOf(text))
	}
	return out
}

// stepDrift describes every inline code span that the numbered step of a doc
// and the same step of its page do not both name. Prose, links, front matter
// and the order of the spans inside a step are free to differ.
func stepDrift(doc, page string) []string {
	d, p := stepSpans(doc), stepSpans(page)
	if len(d) == 0 {
		return []string{"the doc has no numbered step, there is nothing to compare"}
	}
	var out []string
	if len(d) != len(p) {
		out = append(out, fmt.Sprintf("the doc has %d numbered steps, the page has %d", len(d), len(p)))
	}
	for i := 0; i < len(d) && i < len(p); i++ {
		for _, s := range missing(d[i], p[i]) {
			out = append(out, fmt.Sprintf("step %d names `%s` in the doc, not in the page", i+1, s))
		}
		for _, s := range missing(p[i], d[i]) {
			out = append(out, fmt.Sprintf("step %d names `%s` in the page, not in the doc", i+1, s))
		}
	}
	return out
}

// TestSiteMirrorsTheNumberedSteps fails when a path, a unit or a flag in
// backticks is named by a numbered step of docs/ and not by the same step of
// its page, or the other way round. TestSiteMirrorsTheDocs reads fenced blocks
// only, while the removal order of RESET.md is numbered prose whose paths and
// units sit in inline spans: the page lost a file from step 2 and a
// package-hold release from step 7 without a single block changing.
//
// Its reach stops at those spans. It never compares the words around them,
// whether a step is right about what the code does, or text outside a
// numbered list, whose spans TestSiteMirrorsTheSections reads for the
// documents that opt in; only human review catches the rest.
func TestSiteMirrorsTheNumberedSteps(t *testing.T) {
	for _, doc := range steppedDocs {
		docSrc, pageSrc := readMirror(t, doc)
		for _, d := range stepDrift(docSrc, pageSrc) {
			t.Errorf("docs/%s and the site page %s differ: %s", doc, mirrored[doc], d)
		}
	}
}

// TestStepDriftReadsSpansNotProse pins what the step comparison reads and what
// it leaves alone, on a small source. Without it a parser that stopped finding
// steps or spans would let the real pages pass in silence.
func TestStepDriftReadsSpansNotProse(t *testing.T) {
	doc := strings.Join([]string{
		"# Order",
		"",
		"1. Units `a`, `b c` and ``d`e``,",
		"   see `OPERATIONS.md`.",
		"2. Files `f`:",
		"",
		"   ```bash",
		"   echo `not a span`",
		"   ```",
		"",
		"   and `g`, after a blank line.",
		"",
		"After the list, `h` belongs to no step.",
	}, "\n")
	page := strings.Join([]string{
		"---",
		"title: Ordre",
		"---",
		"",
		"1. Autres mots, [`a`](/docs/x), ``d`e``, `b",
		"   c` ([Opérations](/docs/operations)).",
		"2. Fichiers `g` puis `f`.",
		"",
		"Après la liste, `z` n'est dans aucune étape.",
	}, "\n")

	if got := stepDrift(doc, page); len(got) != 0 {
		t.Errorf("other prose, links, wrapping and order must not count as drift, got %q", got)
	}
	got := stepDrift(doc, strings.Replace(page, "`g`", "`x`", 1))
	want := []string{
		"step 2 names `g` in the doc, not in the page",
		"step 2 names `x` in the page, not in the doc",
	}
	if !slices.Equal(got, want) {
		t.Errorf("a span changed in one step: got %q, want %q", got, want)
	}
	got = stepDrift(doc, strings.Replace(page, "2. Fichiers `g` puis `f`.", "", 1))
	want = []string{"the doc has 2 numbered steps, the page has 1"}
	if !slices.Equal(got, want) {
		t.Errorf("a step missing from the page: got %q, want %q", got, want)
	}
	if got := stepDrift("No list here, only `a`.", page); len(got) != 1 {
		t.Errorf("a doc without numbered steps must fail loudly, got %q", got)
	}
}

// section is the inline code spans named under one heading of a source.
type section struct {
	heading string
	spans   map[string]bool
}

// withoutFrontMatter drops the YAML block that opens an MDX page.
func withoutFrontMatter(src string) string {
	if rest, ok := strings.CutPrefix(src, "---\n"); ok {
		if _, body, ok := strings.Cut(rest, "\n---\n"); ok {
			return body
		}
	}
	return src
}

// sectionSpans returns the sections of a Markdown or MDX source in order, each
// with the inline code spans of its text up to the next heading. The text
// before the first heading is the first section, under an empty heading. Front
// matter, the level-1 title and fenced blocks are left out (codeBlocks compares
// those), and a heading that comes back gets its rank appended, so that every
// section has a key of its own.
func sectionSpans(src string) []section {
	sections, texts := []section{{}}, []string{""}
	seen := map[string]int{}
	fenced := false
	for _, line := range strings.Split(withoutFrontMatter(src), "\n") {
		text := strings.TrimSpace(line)
		if strings.HasPrefix(text, "```") {
			fenced = !fenced
			continue
		}
		if fenced || strings.HasPrefix(line, "# ") {
			continue
		}
		if m := sectionHeading.FindStringSubmatch(line); m != nil {
			heading := strings.Join(strings.Fields(m[1]), " ")
			if seen[heading]++; seen[heading] > 1 {
				heading += fmt.Sprintf(" (%d)", seen[heading])
			}
			sections, texts = append(sections, section{heading: heading}), append(texts, "")
			continue
		}
		texts[len(texts)-1] += " " + text
	}
	for i := range sections {
		sections[i].spans = spansOf(texts[i])
	}
	return sections
}

// sectionName is how a message names a section.
func sectionName(heading string) string {
	if heading == "" {
		return "before the first heading"
	}
	return fmt.Sprintf("%q", heading)
}

// sectionDrift describes every inline code span that a section of a doc and the
// section of its page under the same heading do not both name, and every
// heading that only one of them has. Prose, links, front matter, the level-1
// title and the order of the sections and of the spans are free to differ.
func sectionDrift(doc, page string) []string {
	d, p := sectionSpans(doc), sectionSpans(page)
	if len(d) == 1 {
		return []string{"the doc has no heading, there is nothing to compare"}
	}
	index := func(sections []section) map[string]map[string]bool {
		byHeading := map[string]map[string]bool{}
		for _, s := range sections {
			byHeading[s.heading] = s.spans
		}
		return byHeading
	}
	inDoc, inPage := index(d), index(p)
	var out []string
	for _, s := range d {
		name := sectionName(s.heading)
		spans, ok := inPage[s.heading]
		if !ok {
			out = append(out, fmt.Sprintf("the doc has the section %s, the page does not", name))
			continue
		}
		for _, sp := range missing(s.spans, spans) {
			out = append(out, fmt.Sprintf("section %s names `%s` in the doc, not in the page", name, sp))
		}
		for _, sp := range missing(spans, s.spans) {
			out = append(out, fmt.Sprintf("section %s names `%s` in the page, not in the doc", name, sp))
		}
	}
	for _, s := range p {
		if _, ok := inDoc[s.heading]; !ok {
			out = append(out, fmt.Sprintf("the page has the section %s, the doc does not", sectionName(s.heading)))
		}
	}
	return out
}

// TestSiteMirrorsTheSections fails when a path, a unit, a flag or a marker in
// backticks is named by a section of docs/ and not by the section of its page
// under the same heading, or the other way round. It reads what the numbered
// steps cannot: the rows of an options table and the paragraphs around a
// command, where the page of OPERATIONS.md fell short of the document without
// a single block changing.
//
// Its reach stops at those spans. A span counts once per section, so naming it
// in another row or paragraph of the same section satisfies it; the words
// around the spans are never compared, and a row can lose a sentence that holds
// none. The headings must match on both sides, which also keeps the anchors
// that other pages link to. Only human review catches the rest.
func TestSiteMirrorsTheSections(t *testing.T) {
	for _, doc := range sectionedDocs {
		docSrc, pageSrc := readMirror(t, doc)
		for _, d := range sectionDrift(docSrc, pageSrc) {
			t.Errorf("docs/%s and the site page %s differ: %s", doc, mirrored[doc], d)
		}
	}
}

// TestSectionDriftReadsSpansNotProse pins what the section comparison reads and
// what it leaves alone, on a small source. Without it a parser that stopped
// finding headings or spans would let the real pages pass in silence.
func TestSectionDriftReadsSpansNotProse(t *testing.T) {
	doc := strings.Join([]string{
		"# Title",
		"",
		"Intro, `a`.",
		"",
		"## One",
		"",
		"| Option | Effect |",
		"|---|---|",
		"| `--b` | Sets `c`, then",
		"`d e` (see `OPERATIONS.md`). |",
		"",
		"```bash",
		"echo `not a span`",
		"```",
		"",
		"## Two",
		"",
		"Names `f`.",
	}, "\n")
	page := strings.Join([]string{
		"---",
		"title: Titre",
		"---",
		"",
		"Autres mots, [`a`](/docs/x).",
		"",
		"## One",
		"",
		"| Option | Effet |",
		"|---|---|",
		"| `--b` | Autre prose : `d",
		"e`, `c`. |",
		"",
		"## Two",
		"",
		"Nomme [`f`](/docs/f).",
	}, "\n")

	if got := sectionDrift(doc, page); len(got) != 0 {
		t.Errorf("other prose, links, wrapping, order and the title must not count as drift, got %q", got)
	}
	got := sectionDrift(doc, strings.Replace(page, "`c`", "`x`", 1))
	want := []string{
		"section \"One\" names `c` in the doc, not in the page",
		"section \"One\" names `x` in the page, not in the doc",
	}
	if !slices.Equal(got, want) {
		t.Errorf("a span changed in a table row: got %q, want %q", got, want)
	}
	got = sectionDrift(doc, strings.Replace(page, "[`a`](/docs/x)", "rien", 1))
	want = []string{"section before the first heading names `a` in the doc, not in the page"}
	if !slices.Equal(got, want) {
		t.Errorf("a span missing from the text before the first heading: got %q, want %q", got, want)
	}
	got = sectionDrift(doc, strings.Replace(page, "## Two", "## Deux", 1))
	want = []string{
		"the doc has the section \"Two\", the page does not",
		"the page has the section \"Deux\", the doc does not",
	}
	if !slices.Equal(got, want) {
		t.Errorf("a heading renamed in the page: got %q, want %q", got, want)
	}
	if got := sectionDrift("No heading here, only `a`.", page); len(got) != 1 {
		t.Errorf("a doc without headings must fail loudly, got %q", got)
	}
}

// The public site claimed for months that the link carried "four provider
// verbs" and never a restart, long after the allowlist had grown to thirty
// routes including the gateway restart. Nobody noticed, because prose is not
// compiled. The site no longer publishes the route inventory; the one written
// in docs/CONNECTOR.md is compared to the same source as the code, and this
// test fails the moment they disagree.
//
// Its reach stops at that inventory, and saying so is part of the guard. It
// compares route-shaped lines inside fenced blocks (the fence language is not
// filtered) and never the prose around them; it
// collapses every bounded segment to `*`, so a grammar that changes is
// invisible; it ignores whether a route sits under the right heading, and
// whether it is a gateway or a host route. A page can therefore list the right
// routes and still lie next to them. Only human review catches that.

// literalAlt matches a plain alternation of literal words, `(stop|steer)`.
var literalAlt = regexp.MustCompile(`\((?:[a-z]+\|)+[a-z]+\)`)

// reAtom matches one regex atom that stands for a bounded variable segment
// (a character class or a non-capturing group) plus its optional quantifier.
var reAtom = regexp.MustCompile(`(?:\(\?:(?:[^()]|\([^()]*\))*\)|\[[^\]]*\])(?:\{\d+(?:,\d+)?\})?`)

var manyStars = regexp.MustCompile(`\*+`)

// docSegment matches the `{profile}` placeholders the page writes.
var docSegment = regexp.MustCompile(`\{[a-z]+\}`)

// docRouteLine matches one route line of the fenced blocks of CONNECTOR.md.
var docRouteLine = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE)\s+(/\S*)$`)

// routeKeys renders one allowlist entry as the `METHOD path` keys a reader
// would see, every variable segment collapsed to `*`. An alternation becomes
// one key per branch, because the page spells those out.
func routeKeys(r connector.Route) []string {
	src := strings.TrimSuffix(strings.TrimPrefix(r.Path.String(), "^"), "$")
	bodies := []string{src}
	if m := literalAlt.FindString(src); m != "" {
		bodies = nil
		for _, branch := range strings.Split(strings.Trim(m, "()"), "|") {
			bodies = append(bodies, strings.Replace(src, m, branch, 1))
		}
	}
	keys := make([]string, 0, len(bodies))
	for _, b := range bodies {
		b = manyStars.ReplaceAllString(reAtom.ReplaceAllString(b, "*"), "*")
		keys = append(keys, r.Method+" "+b)
	}
	return keys
}

// TestConnectorDocListsEveryAllowlistedRoute keeps the inventory of
// docs/CONNECTOR.md exactly equal to connector.Allowlist: a route added to the
// code and not to the document is an undocumented capability, and a route in
// the document that the code refuses is a promise the host does not keep.
func TestConnectorDocListsEveryAllowlistedRoute(t *testing.T) {
	page := filepath.Join("..", "..", "docs", "CONNECTOR.md")

	inCode := map[string]bool{}
	for _, r := range connector.Allowlist {
		for _, k := range routeKeys(r) {
			if strings.ContainsAny(k, "[]()?") {
				t.Errorf("route %q did not normalise to a readable path; teach routeKeys the new pattern", k)
			}
			inCode[k] = true
		}
	}

	inPage := map[string]bool{}
	for _, block := range codeBlocks(t, page) {
		for _, line := range strings.Split(block, "\n") {
			m := docRouteLine.FindStringSubmatch(strings.TrimSpace(line))
			if m == nil {
				continue
			}
			inPage[m[1]+" "+docSegment.ReplaceAllString(m[2], "*")] = true
		}
	}

	for _, k := range missing(inCode, inPage) {
		t.Errorf("connector.Allowlist carries %q, docs/CONNECTOR.md does not list it", k)
	}
	for _, k := range missing(inPage, inCode) {
		t.Errorf("docs/CONNECTOR.md lists %q, connector.Allowlist refuses it", k)
	}
}

func missing(from, in map[string]bool) []string {
	var out []string
	for k := range from {
		if !in[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// TestNoPageClaimsFourProviderVerbs is the specific regression: the phrase
// that stayed true for one release and false for six.
func TestNoPageClaimsFourProviderVerbs(t *testing.T) {
	dir := sitePages(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	// `exec` and `update` are still never carried; `restart` is, for the
	// gateway alone, so a page may only name it alongside that exception.
	stale := []string{"quatre verbes fournisseur", "`exec` / `update` / `restart`", "exec/update/restart"}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".mdx") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, phrase := range stale {
			if strings.Contains(string(data), phrase) {
				t.Errorf("%s still claims %q; the link carries the whole host allowlist, and one restart", e.Name(), phrase)
			}
		}
	}
}
