# YoinkIt

For educationally yoinking the good stuff.

**A web-animation yoinker.** It reads what an animation *actually does* by
sampling computed style every frame — regardless of how it is driven: CSS
transitions/keyframes, GSAP inline transforms on `requestAnimationFrame`, or CSS
sprite `steps()`. The built-in DevTools **Animations** panel only sees CSS/WAAPI
animations, so it shows nothing for GSAP- or canvas-driven motion; this sees
everything because it reads the rendered result.

The output is **yoinked motion, not code**: detected libraries, a one-line plain-English
`summary` of the whole animation, and a `findings` array - each animating layer
with its measured timing/easing and a frame-by-frame timeline. Capturing is the
tool's job; **writing the recreation is the LLM's job** - hand the spec to a
coding agent (paste it, or use it from the console) and it builds a faithful
version in your stack. `dump()` returns the spec and copies the pure JSON to the
clipboard; automation can use `dump({ copy:false })`.

It's designed to feed AI coding agents a two-part workflow: **map** a page
cheaply (structure, stack, selectors), then **capture** the motion of the pieces
that matter and recreate them. The capture must run in a real, rendered browser
(headless synthetic events don't fire most hover/scroll handlers).

For trusted local `agent-browser` runs on Martin's machine, use the wrapper so
every command keeps the same session, no-confirm flags, and Hyprland window
class:

```bash
./bin/capture-browser open https://example.com/ --headed --init-script extension/capture-animation.js
./bin/capture-browser set viewport 1280 800
```

`bin/capture-browser` defaults `AGENT_BROWSER_SESSION=yoink`, injects
`--args "--class=claude-mcp"` only on `open` commands for the floating
second-monitor rule, and passes `--confirm-actions "" --confirm-interactive false`
every time. Agents should save JSON from `window.__capLast` /
`window.__capBootLast` after calling `dump({ copy:false })` or
`bootDump({ copy:false })`.

## Repeatable local pipeline CLI

`bin/yoinkit` currently implements the pre-gate Map workbench. It materializes a
run, proves Recon, Static Map, Motion Scout, and Report v0 artifacts, then stops
at the Map Gate so human review remains explicit. Capture, full yoink, Spec
generation, implementation, Report edit-back, and later improve loops are not
public CLI commands in this slice.

The implemented flow is `init -> map -> map-gate`:

```bash
RUN="$(./bin/yoinkit init https://mammothmurals.com/)"
REPORT="$(./bin/yoinkit map "$RUN")"
# Open "$REPORT" and review Report v0 before deciding.
./bin/yoinkit map-gate "$RUN" --approve --note "Report v0 approved for Capture"
```

`init` materializes the run shell only: `00-config.json` and the minimal
`page-model.json`, under `yoink-runs/<host>/<date>-<slug>/` unless `--run-dir`
is supplied. It resolves viewport shorthand and the primary viewport, then
stops. It does not open a browser, map the page, propose captures, or write
later-stage artifacts.

`map` runs `recon -> static-map -> motion-scout -> map-report`, then stops before
Map Gate. On success it prints the absolute Report v0 path. If a stage fails,
it stops there, exits non-zero, preserves completed artifacts, and writes or
propagates the failing stage's status artifact.

Direct stage reruns are available when you need deterministic repair of one
pre-gate step:

```bash
./bin/yoinkit recon "$RUN"
./bin/yoinkit static-map "$RUN"
./bin/yoinkit motion-scout "$RUN"
REPORT="$(./bin/yoinkit map-report "$RUN")"
```

`recon` reads that run configuration, probes the configured viewport set, writes
`01-recon/` evidence, and updates only Recon-owned page-level facts in
`page-model.json`. It does not create Regions, motion candidates, Report output,
or later-stage artifacts.

`static-map` requires completed Recon evidence, measures section-level Regions,
writes `02-static-map/` measurements, assertions, coverage, crops, and safely
fetchable asset evidence, and updates only Static Map-owned Region fields in
`page-model.json`. Region typography, colors, assets, layout, crops, and
unknowns stay factual evidence: missing values are recorded as `null + reason`,
not inferred tokens or implementation components. It does not create motion
candidates, gate records, Report output, or implementation facts.

`motion-scout` requires the Static Map Region scaffold, reads likely motion clues
from the capture engine map plus runner-owned affordance probes, writes
`03-motion-scout/motion-candidates.json`, assertions, and coverage, and attaches
only candidate id references back to each Region. Candidate records are runnable
leads for later Capture: trigger, target selector, Region attachment or
`null + reason`, evidence source, recipe skeleton, viewport applicability, and a
mechanical priority hint. They deliberately do not store measured duration,
easing, from/to values, sampled timelines, capture ids, Signature importance, or
implementation component/token names.
Coverage records whether each required discovery source was inspected for each
measured viewport. A source with zero candidates can pass when inspected; a
source-level probe failure blocks only that source and keeps sibling evidence.

`map-report` requires completed Recon, Static Map, and Motion Scout artifacts,
then writes the portable static Report v0 to `04-map-report/index.html` and
prints its absolute path. It also writes `04-map-report/report-snapshot.json`,
the same structured snapshot embedded in the HTML, for programmatic consumers.
The HTML embeds the Page model projection, assertion and coverage snapshots,
motion candidates, and input hashes, while linking crops and copied asset
evidence by relative path. It does not open a browser by default.

Review the Report before crossing into Capture. `map-gate` records the explicit
human decision in `04-map-report/gate.json`; it never decides approval by itself.
Final approval requires a fresh Report v0, passing required assertions, complete
required coverage, reasoned unknowns, and approved blocking exceptions:

```bash
./bin/yoinkit map-gate "$RUN" --approve --note "Report v0 approved for Capture"
./bin/yoinkit map-gate "$RUN" --reject --reason "Hero crop needs another pass"
./bin/yoinkit map-gate "$RUN" --approve-exception exception-hero-crop \
  --reason "Cookie banner is source-owned and accepted for Map v0" \
  --scope region:region-hero
```

Approving an exception stores a canonical human-approved exception in
`page-model.json` and records it in `gate.json`, but it is not final gate
approval. Because it edits `page-model.json`, the Report v0 is now stale;
regenerate it before final approval so the human reviews the exception in place:

```bash
./bin/yoinkit map-report "$RUN"
./bin/yoinkit map-gate "$RUN" --approve --note "Report v0 approved for Capture"
```

Markdown coverage statuses such as `approved` or `exception` do not waive a
required item; only canonical `page-model.json` exceptions can do that.

Asset fetching is safe by default. Same-origin assets are fetched; `file:` and
cross-origin assets are skipped, reported in `coverage.md`, and printed in the
CLI summary without blocking unless strict mode is enabled. Trusted overrides are
explicit and persisted into `00-config.json` before the stage runs:

```bash
./bin/yoinkit static-map "$RUN" --allow-file-assets --file-asset-root ./trusted-assets
./bin/yoinkit static-map "$RUN" --fetch-public-cross-origin-assets
./bin/yoinkit static-map "$RUN" --strict-skipped-assets
```

Pre-gate artifacts live in the run directory:

```text
00-config.json
page-model.json
01-recon/page-state.json
01-recon/viewport-manifest.json
01-recon/source-metadata.json
01-recon/stage-status.json (failure-only)
02-static-map/measurements.json
02-static-map/assertions.json
02-static-map/coverage.md
02-static-map/stage-status.json (failure-only)
03-motion-scout/motion-candidates.json
03-motion-scout/assertions.json
03-motion-scout/coverage.md
03-motion-scout/stage-status.json (failure-only)
04-map-report/index.html
04-map-report/report-snapshot.json
04-map-report/stage-status.json (failure-only)
```

`yoinkit map` stops before `map-gate`; `04-map-report/gate.json` appears only
after `yoinkit map-gate`. If `yoinkit map` stops on a failed stage, the
failure-only `stage-status.json` records the stage, status, error, and
`errorName`.

## Two ways to load it

### 1. Unpacked extension (primary)

`extension/` is an MV3 extension whose content script runs early in the page's
MAIN world and defines `window.__cap` on **every page automatically** - no
pasting, ever. It also opportunistically instruments the page's own GSAP and
CustomEase globals when they exist, so captures can include source evidence such
as tween targets, duration, ease, stagger, and CustomEase path data. Edit
`extension/capture-animation.js` and the change is live on the next extension
reload.

Load it once:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` directory in this repo
3. `__cap` is now present on every page. After editing the engine, hit the
   **reload** ↻ on the extension card.

(Alternative: launch Chrome with `--load-extension=<repo>/extension`.)

### 2. DevTools Snippet (fallback)

When you can't load the extension, use the snippet:

```bash
./install.sh       # installs the engine + the `capture-snippet` helper
capture-snippet    # copies the engine to the clipboard
```

Then **DevTools (F12) → Sources → Snippets → New snippet → paste → Ctrl+S**, and
run it (Ctrl+Enter) on each page. Re-run `capture-snippet` and paste over after
editing the engine.

## Use — the toolbar button (easiest)

Click the extension's **toolbar button** (the crosshair). The cursor becomes an
element picker, like DevTools' Ctrl+Shift+C:

1. **Hover** the element so its animation plays (the picker highlights it).
2. **Click** it.

That captures the element's subtree and dumps the spec to the **console +
clipboard** in one gesture — no selectors, no navigation (the click is
swallowed). Press **Esc** to cancel. Same thing from the console: `__cap.pick()`.

The picker captures from the nearest interactive ancestor (`a` / `button`) so it
catches effects that live on a child you're not directly pointing at.

> After updating the extension you must **reload it** at `chrome://extensions`
> (the ↻ on its card) — manifest/background changes don't hot-reload like the
> content script does.

## Use — the console (full control)

```js
__cap.libs()                         // which animation libraries are loaded
__cap.on('.selector')                // capture one element on hover (default)
__cap.on('.sel', {trigger:'scroll'}) // capture on scroll-into-view
__cap.scan('.section')               // diff-scan: find what moves in a region
__cap.scan($0)                       // capture the element selected in Elements
__cap.gsap()                         // inspect logged GSAP/CustomEase evidence
__cap.dump()                         // finalize -> returns + copies the spec JSON
__cap.dump({ copy:false })           // automation-safe: no clipboard write
```

Triggers: `hover` (default) · `scroll` · `load` · `manual`. Tip: `$0` is the
element currently selected in the Elements panel — handy for `on`/`scan`.

For load-time reveals, use the boot recorder. It watches likely elements for a
fixed early window and can be auto-started from an init script:

```js
__cap.boot({ selectors: ['h1', '[class*=split]', '[class*=hero]'], ms: 4000 })
__cap.bootDump()
__cap.bootDump({ copy:false }) // automation-safe
```

When using `agent-browser --init-script`, a tiny config init script can set
`window.__capAutoBoot` before loading the engine:

```js
window.__capAutoBoot = { selectors: ['h1', '[class*=split]'], ms: 4000 }
```

### When to use `on` vs `scan`

- `__cap.on(sel)` tracks one element (and auto-detects split-text stagger when
  it has many similar children). Use it when you can name the exact element.
- `__cap.scan(root)` snapshots every element under `root` and reports the ones
  whose style changes during your interaction. Use it when the animation lives
  on a **descendant** of what you can target, or on a layer you can't click
  (`pointer-events:none`, sitting behind text). This is the robust default for
  anything non-obvious.

### Capturing reliably (learned the hard way)

- **The animation must actually be running during the capture window.** Some
  sites gate effects behind scroll/in-view state; make sure it's playing before
  `dump()`. For a one-shot transition the reliable recipe is:
  **settle → arm (`on`/`scan`) → trigger → wait the duration → `dump()`**.
- **Hover triggers need the cursor to *cross into* the element.** If the pointer
  is already over it, no `mouseenter` fires and nothing records. Move away
  first, then hover.
- **A real browser is required.** Headless/synthetic events usually don't fire
  framework hover/scroll handlers (Webflow IX2, GSAP), and the headless
  compositor may not advance transitions. Drive it in a real, rendered tab.
- **Ambiguous selectors bite.** `querySelector` takes the first match in the
  document, which may not be the one on screen. Prefer a unique selector or use
  `scan` on a specific container element.
- 3D-matrix rotation decomposition is approximate (flagged `_approx3d`). The raw
  matrices and translate/scale are exact; treat Euler angles as close-but-verify.
- GSAP easing is not visible in computed style, but the engine now logs GSAP
  calls made after it is injected. When that evidence is present, prefer the
  logged `duration`, `ease`, `stagger`, and target data over curve guessing.
  CSS-transition easing is still read authoritatively from computed style.

## Files

- `extension/manifest.json` — MV3 extension (toolbar action + MAIN-world content
  script + service worker).
- `extension/capture-animation.js` — the engine + picker (single source of truth,
  used by both the extension and the snippet fallback).
- `extension/background.js` — service worker; toolbar click toggles the picker.
- `extension/icons/` — toolbar/extension icons (generated from `icon.svg`).
- `bin/capture-snippet.sh` — clipboard helper for the DevTools-snippet fallback.
- `install.sh` — installs the engine to `~/.local/share/yoinkit/` and
  `capture-snippet` to `~/.local/bin/`.

## License

MIT — see [LICENSE](LICENSE).
