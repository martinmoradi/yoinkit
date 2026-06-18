# Subslice 02d Cross-Check Notes

Target: `audit/impeccable/reports/02-chrome-extension/02d-devtools-surfaces.md`
Parent context: `audit/impeccable/reports/02-chrome-extension/02-chrome-extension.md`
Source root: `audit/impeccable/source`

Source checked against restored upstream clone `pbakaus/impeccable` at `1c897a0`
(`2026-06-17T17:49:38+09:00`, "Polish docs page"). The source clone was missing
when the resolver first ran, so line-drift notes below are against this current
clone rather than a recorded audit SHA.

## Executive Delta

- The core 02d thesis is confirmed: DevTools surfaces are thin UI shells around
  the service-worker hub, with `devtools.js` registering the panel/sidebar,
  `panel.js` rendering grouped findings and copy-as-markdown, `sidebar.js`
  resolving `$0` by asking the inspected page, and `popup.js` acting as a
  transient toolbar surface.
- Three substantive corrections should be applied before integration:
  `autoScan` does not broadcast a rescan when changed; the sidebar port is
  receive-only and not actually self-reconnecting after service-worker death;
  several file counts in the leaf and parent are off by one in the restored
  source.
- The report's strongest transferable patterns hold up: `$0` matching by
  JSON-stringifying all selectors into `inspectedWindow.eval`, click-to-`inspect`
  from engine-owned selectors, panel/popup versus toolbar count inconsistency,
  DevTools theme bridging, page-pointer reverse signaling, and copy-as-markdown
  via the extension page clipboard.
- All local markdown links in the 02d leaf and 02 parent resolve once
  `audit/impeccable/source/` exists. The generated `extension/detector/` files
  are intentionally absent from the clone and created by `scripts/build-extension.js`.

## Corrections To Apply

| Report area | Current claim | Evidence | Suggested change |
|---|---|---|---|
| 02d surface map and parent file map | `devtools.js (51 lines)` and `sidebar.js (104 lines)`. Parent repeats 51 and 104 in the extension file map. | In the restored source, `extension/devtools/devtools.js` is 50 content lines and ends with a newline; numbered source runs lines 1-50. `extension/devtools/sidebar.js` is 103 content lines and ends with a newline; numbered source runs lines 1-103. | Change 02d and parent counts to `devtools.js (50 lines)` and `sidebar.js (103 lines)`. Keep `panel.js (519)` and `popup.js (67)`, which match. |
| Parent file map counts | Parent says `STORE_LISTING.md` is 70 lines, `scripts/build-extension.js` is 160, and `scripts/build-browser-detector.js` is 63. | Recomputed content-line counts from `source`: `extension/STORE_LISTING.md` is 69, `scripts/build-extension.js` is 159, and `scripts/build-browser-detector.js` is 62. All three end with newlines, so this is not a `wc -l` trailing-newline artifact. | Adjust those parent counts if the integration pass touches the file map. |
| Per-rule/settings broadcast | 02d says toggling "a rule or a setting" writes `storage.sync` and fires `disabled-rules-changed`, so every setting change immediately rescans. | Rule toggles call `chrome.runtime.sendMessage({ action: 'disabled-rules-changed' })` in `extension/devtools/panel.js:155-163`; line length does too at `panel.js:86-99`; spotlight blur does too at `panel.js:102-109`. `autoScan` only writes `chrome.storage.sync.set({ autoScan: mode })` at `panel.js:71-83` and sends no rescan message. The service worker only rescans on `disabled-rules-changed` at `extension/background/service-worker.js:139-145`. | Narrow the claim: rule toggles, line-length mode, and spotlight blur broadcast and rescan injected tabs; `autoScan` is persisted and affects future DevTools/panel-open behavior, but does not rescan the current page. |
| Sidebar port survival | 02d says `sidebar.js` has "an auto-reconnecting port for receiving findings." 02b also says panel and sidebar recreate their ports lazily via `getPort()`. | `extension/devtools/sidebar.js:17-28` defines `getPort()` and sets `port = null` on disconnect, but the only call is the initial `getPort()` at `sidebar.js:29`. Selection refresh at `sidebar.js:31-67` never calls `getPort()`, and the sidebar has no heartbeat or `postToPort` equivalent. The service-worker sidebar branch at `extension/background/service-worker.js:225-238` sends initial state and scan-if-empty, then removes the port on disconnect. | Describe the sidebar as a named receive-only port that is reconnect-capable in helper shape but not self-reconnecting in the current implementation. If YoinkIt copies this, add a reconnect trigger on selection changes or a heartbeat. |

## Deep Implementation Notes

- Confirmed `devtools.js` registration and lifecycle behavior:
  `extension/devtools/devtools.js:9-19` creates the panel and Elements sidebar.
  The lifecycle port name is `impeccable-devtools-{tabId}` at `devtools.js:23`.
  First connection reads `chrome.storage.sync.get({ autoScan: 'panel' })` and
  scans only when the saved value is `devtools` at `devtools.js:31-37`.
  Disconnect reconnects with `setTimeout(connectLifecycle, 100)` at
  `devtools.js:39-43`, and a 20s keepalive posts `{ action: 'ping' }` at
  `devtools.js:47-50`.
- Confirmed panel port behavior:
  `extension/devtools/panel.js:19-34` lazily recreates its named port and retries
  a failed `postMessage` once. It immediately opens a port at `panel.js:188-189`
  and keeps the service worker warm with a 20s ping at `panel.js:191-193`.
  The service-worker panel branch sends current state, then scans if findings are
  empty at `extension/background/service-worker.js:189-219`.
- Confirmed the three `inspectedWindow.eval` uses:
  click-to-inspect is `inspectElement(selector)` at
  `extension/devtools/panel.js:503-511`, with the selector encoded via
  `JSON.stringify` before interpolating into the eval string. The URL stamp for
  copy-as-markdown strips `location.hash` at `panel.js:277-285` and interpolates
  no page text. `$0` matching is `extension/devtools/sidebar.js:50-66`, where
  all candidate selectors are JSON-stringified, queried in the inspected page,
  and matched by strict identity against `$0`; invalid selectors are caught per
  selector.
- Confirmed finding grouping and count semantics:
  `renderFindings()` at `extension/devtools/panel.js:392-501` groups by category
  (`slop` and `quality`) and then by anti-pattern `type`, renders category and
  group counts, and wires click-to-inspect only for non-page, non-hidden rows at
  `panel.js:487-490`. The panel badge sums individual findings at `panel.js:405-407`.
  The popup uses the same individual-finding count in `extension/popup/popup.js:19-24`
  and live updates at `popup.js:36-44`. The toolbar badge counts flagged entries
  instead, `state.findings.length`, in `extension/background/service-worker.js:21-26`.
- Confirmed settings source and generated artifact shape:
  `extension/devtools/panel.js:51-69` fetches
  `chrome.runtime.getURL('detector/antipatterns.json')`, then loads
  `disabledRules`, `lineLengthMode`, `spotlightBlur`, and `autoScan` from
  `storage.sync`. The settings controls exist in `extension/devtools/panel.html:30-53`.
  The JSON file is generated by `scripts/build-extension.js:71-82` from
  `ANTIPATTERNS`, while `extension/detector/` is gitignored at `.gitignore:74-75`
  and absent from the fresh clone.
- Confirmed theme bridge:
  `extension/devtools/panel.js:8-11` and `extension/devtools/sidebar.js:7-9`
  add `.theme-dark` when `chrome.devtools.panels.themeName === 'dark'`.
  `extension/devtools/panel.css:7-18` defines the light token block and
  `panel.css:20-30` overrides it for `.theme-dark`. Sidebar has the same JS
  theme hook and its own CSS token file.
- Confirmed hover and reverse-signal behavior:
  panel hover posts `highlight`/`unhighlight` through `setHoveredItem()` and the
  delegated listeners at `extension/devtools/panel.js:368-389`. The injected
  engine handles highlight at `cli/engine/browser/injected/index.mjs:1878-1903`
  by resolving the selector, optionally scrolling it into view, marking overlays,
  and calling `showSpotlight(target)`. The content script listens to page
  `pointermove`, throttles to 150ms, and sends `page-pointer-active` at
  `extension/content/content-script.js:72-81`; the panel clears hover on that
  message at `panel.js:165-171`.
- Confirmed copy-as-markdown:
  `FIX_SKILLS` lives at `extension/devtools/panel.js:224-254`,
  `uniqueSkillsForFindings()` frequency-sorts skills at `panel.js:262-275`,
  all-findings markdown is emitted by `formatFindingsForCopy()` at
  `panel.js:287-330`, per-finding markdown by `formatSingleFindingForCopy()` at
  `panel.js:332-344`, and the clipboard write is `navigator.clipboard.writeText`
  at `panel.js:346-362`. The report's "no page-context clipboard prompt" point
  is an inference from this being an extension page plus a user click, not a
  runtime-tested fact in this pass.
- Confirmed popup shape:
  `extension/popup/popup.js:29-33` requests `get-state` for the active tab,
  `popup.js:36-49` handles broadcast updates, and `popup.js:51-65` sends one-shot
  `scan` and `toggle-overlays` messages with explicit `tabId`. There is no
  long-lived popup port.
- Confirmed escaping:
  panel row HTML escapes selector, detail, group name, and description through
  `escapeHtml()` at `extension/devtools/panel.js:451-478` and `panel.js:513-517`.
  Sidebar escapes the empty-state text and each finding's name/detail/description
  at `extension/devtools/sidebar.js:69-103`.

## Paradigms Worth Importing

- For YoinkIt's Capture panel, copy the division of labor rather than the exact
  UI code: keep the capture engine in MAIN world, make the service worker the
  per-tab state hub, and let DevTools pages render results without touching the
  page except through narrowly scoped `inspectedWindow.eval` calls.
- The `$0` matching pattern is especially transferable: store selectors in the
  capture result, then when a user selects an element in Elements, JSON-stringify
  all candidate selectors into an eval and ask the page which selectors resolve
  to `$0`. This avoids maintaining a fragile element-to-result map across
  DevTools reloads.
- Use one count vocabulary before building YoinkIt surfaces. Impeccable's
  mismatch is real and visible: action badge equals flagged entries, while panel
  and popup equal individual findings. YoinkIt should choose one of captured
  layers, tracked elements, or issues and use it consistently.
- Treat settings according to whether they affect current capture state.
  Impeccable's line-length and spotlight settings justifiably rescan; `autoScan`
  only changes future opening behavior. YoinkIt should make the same distinction
  for settle time, copy mode, viewport, and capture defaults.
- The reverse-signal hover trick is worth lifting for any panel-to-page spotlight
  flow. When pointerleave from DevTools is unreliable, let page-side pointermove
  prove the user's cursor returned to the page and clear panel hover state.
- Copy-as-markdown is the most YoinkIt-shaped output pattern here. A DevTools
  extension page can offer one-click "copy spec" without the page-context
  clipboard workaround that requires `dump({ copy:false })` and `window.__capLast`.

## Link And Citation Checks

- `02d-devtools-surfaces.md`: every local markdown link resolves after restoring
  `audit/impeccable/source/`, including sibling reports `02a`, `02b`, `02c`,
  parent `02-chrome-extension.md`, and all cited source files under
  `../../source/`.
- `02-chrome-extension.md`: every local markdown link resolves after restoring
  the clone, including report links, `../../00-EXECUTIVE-SUMMARY.md`, and source
  files cited from the parent file map.
- Line anchors for behavioral claims are generally still good in the restored
  clone. The stale anchors are count-like text, not broken file links.
- `extension/detector/detect.js` and `extension/detector/antipatterns.json` are
  generated and intentionally absent from the fresh clone because
  `extension/detector/` is gitignored. The report should keep treating them as
  build artifacts, not missing source.

## Open Questions

- The resolver does not record the upstream audit commit. I restored
  `audit/impeccable/source/` from current upstream `main` at `1c897a0`, which is
  close to the audit date, but an integrator should decide whether to treat the
  line-count drift as upstream movement or a report correction.
- Should the integration pass also update sibling `02b` language around sidebar
  lazy reconnect? The overstatement is clearest in 02d, but 02b also says the
  sidebar recreates its port lazily via `getPort()` even though no post-disconnect
  call path invokes it.
