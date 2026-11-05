# Sign-in templates

The shell's sign-in page (`../signin.html`) has one markup and one behaviour
(`../../preload/preload.ts`, `../signin-base.css`). A template is **one CSS
file** in this folder that gives that markup a look. Pick one with
`OPENEDBOT_SIGNIN_TEMPLATE=<name>` or `"signinTemplate": "<name>"` in
`userData/config.json`; an unknown name falls back to `console-split`.

## Rules

- One file, `<name>.css`, name in `[a-z0-9-]`. No HTML change, no script, no
  new id: if a template needs an element that does not exist, it cannot have it.
- CSP: no inline `style`, no remote URL. Assets only from `../assets/`
  (paths in a template are relative to this folder: `url("../assets/…")`).
- Both themes, chosen by `html[data-theme="dark"|"light"]`. Every colour is
  a custom property set per theme on `html[data-theme=…]`.
- Responsive from 800x560 (the window minimum) to 1920x1200: the submit
  button visible without scrolling at 1000x560 and wider, no horizontal
  scroll at any size, nothing overlapping the form.
- The window has no title bar (`html[data-platform]`, set by the preload):
  the top 46 px drag the window (`.titlebar` in `signin-base.css`), and the
  system buttons float over the page.
  - macOS (`darwin`): the traffic lights at x 16-76, y 16-30. Keep every
    element out of the corner x < 88, y < 46 (most templates push `.brand`
    right with `margin-inline-start`).
  - Windows (`win32`): minimize, maximize and close over the top right
    corner, 46 px high, see-through. Keep every element out of the corner
    x > 100vw - var(--caption-buttons-width) - 12px, y < 46
    (`--caption-buttons-width` is set by `signin-base.css`, about 138 px).
- Keyboard focus visible (`:focus-visible`), `prefers-reduced-motion`
  respected (stop every animation), WCAG AA contrast for text.
- Do not restyle the behaviour rules of `signin-base.css` (`[hidden]`,
  `.waiting` / `body[data-state]`, eye and theme icons); style the parts.
- Fonts available: `"Inter Variable"`, `"Source Serif 4 Variable"` (normal
  and italic), `"JetBrains Mono Variable"`. Nothing else.
- Comments in English, explaining the why. No em dash anywhere.

## The tree

```text
html[data-theme="dark|light"][data-template][data-platform="darwin|win32"]
body[data-state="idle|waiting|submitting|error"][data-google="off"?]
  .titlebar (aria-hidden; macOS and Windows drag strip, owned by signin-base.css: do not style)
  .shell
    .art (aria-hidden; optional, hide it if unused)
      .art-image          empty box: give it a background image
      .deco > .d.d1 … .d12  twelve empty spans for pattern decoration
      img.art-mascot      the openedbot mascot
    main.main
      header.brand > img.brand-mark + span.brand-name ("openedbot")
      .content
        .copy > h1.title + p.lead
        #signin-note.note[data-tone="neutral|warning|danger"]   (hidden when empty)
        .actions
          #providers-loading.hint[data-tone]   ("Loading…", or "API not answering")
          #google-button.btn.btn-google > svg.google-mark + span
          #google-disabled.hint.hint-warning   (why Google is off)
          .waiting > .pending > .matrix + span ; #google-cancel.btn-text
          form#password-form.password
            p.divider > span ("or")
            .field > label.label + span.control > svg.field-icon + input#password-email
            .field > label.label + span.control.control-secret > svg.field-icon + input#password-secret + button#password-eye.eye
            #password-submit.btn.btn-primary
            #dev-accounts.dev > p.dev-title + p.dev-hint + #dev-list.dev-list
              > .dev-choice > p.dev-role + p.dev-account + .dev-actions > button.btn-text.dev-fill + button.btn.btn-primary.dev-submit
      footer.footer
        .legal > p.footnote + nav#legal-links.legal-links > button.legal-link …
        .controls > span#env-badge.env-badge[data-environment="dev|preprod"] (hidden on prod) ; .locale > button.locale-option[aria-pressed] ×2 ; button#theme-toggle.theme-toggle
```

## Assets

| File | What |
|---|---|
| `signin-galaxy.webp` | Painted night scene: the mascot and six bots orbiting above a planet (1536x1024, subject in the middle 55 %). |
| `signin-galaxy-light.webp` | The same scene, light palette. |
| `signin-galaxy-alt.webp` | Night variant: larger mascot, bots spiralling, planet top right. |
| `openedbot-icon.webp` | The mascot alone, transparent, 256 px. |
| `bots/{coral,crystal,ember,jelly,orbit,solar,wave,firefly}.webp` | The console's illustrated bots, 192 px, transparent background (their glow reads best on dark). |

## Checking a template

`/tmp/openedbot-e2e/gallery.ts <name>` renders it in Electron, both themes, at
1280x820, 1000x560, 820x1000 and 800x560, and prints the layout checks.
