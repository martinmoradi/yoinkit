# Subslice 02c Cross-Check Notes

Target: `audit/impeccable/reports/02-chrome-extension/02c-injection-and-main-world.md`
Parent context: `audit/impeccable/reports/02-chrome-extension/02-chrome-extension.md`
Source root: `audit/impeccable/source` (absent in this worktree; verified against `/home/martin/src/perso/yoinkit/audit/impeccable/source`)

## Executive Delta

- The main thesis is confirmed: Impeccable uses an ISOLATED-world content-script bridge, injects the generated detector into MAIN world, falls back from a CSP-blocked script tag to `chrome.scripting.executeScript({ world: 'MAIN' })`, and gates scanning on an explicit `impeccable-ready` handshake. Evidence: `extension/content/content-script.js:21-25,103-123`, `extension/background/service-worker.js:125-137`, and `cli/engine/browser/injected/index.mjs:8-10,1855-1912`.
- Correct one concrete source mismatch in section 5.2: the pixel-sample stack walk at `cli/engine/browser/injected/index.mjs:1037-1040` skips `.impeccable-*` nodes, but it does **not** repeat the `[id^="impeccable-live-"]` skip. That live-overlay skip appears in the visual-contrast candidate loop and main element loop, not in the pixel-sample stack walk.
- Soften the teardown language in section 5.3. The `remove` command clears overlay DOM, style element, spotlight backdrop, and the body visibility class, but it does not unregister global listeners or remove `window.impeccable*` globals. "Fully unloaded" / "leaving no trace" is too strong.
- Qualify the "works even while the service worker is asleep" sentence in section 2. The cheap script-tag tier avoids an extra service-worker fallback round trip once the content script has received a scan command, but the documented flow still starts with the service worker sending `tabs.sendMessage`.
- Automated link check found no broken links in the leaf or parent after remapping `../../source/` to the primary source clone. In this worktree alone, `audit/impeccable/source` is missing, so raw source links and the subslice resolver fail until that clone is present.

## Corrections To Apply

| Report area | Current claim | Evidence | Suggested change |
|---|---|---|---|
| 02c §5.2, visual-contrast and pixel-sample skips | "Visual-contrast candidate loop ... and the pixel-sample stack walk each repeat the `.impeccable-*` / `impeccable-live-` skip." | `collectVisualContrastCandidates` skips both at `cli/engine/browser/injected/index.mjs:658-662`. The pixel stack loop only skips `.impeccable-overlay, .impeccable-label, .impeccable-banner, .impeccable-tooltip` at `index.mjs:1037-1040`. `rg "impeccable-live"` finds live skips at `index.mjs:660-661,1472-1474,1551-1556`, not near `1039`. | Split the claim: visual candidates skip `.impeccable-*` and live overlays; pixel sampling skips `.impeccable-*` only. Consider adding a YoinkIt hardening note: make every capture stack walk use the full tool-chrome exclusion matrix. |
| 02c §5.3, unload semantics | "The `remove` command tears all of it down... So the engine can be fully unloaded from a page, leaving no trace." | `remove` handles `clearOverlays()`, `styleEl.remove()`, spotlight removal, and `impeccable-hidden` removal at `index.mjs:1872-1877`. But window/document listeners remain at `index.mjs:138-141,193-195,251-259,1857-1912`, and public globals remain assigned at `index.mjs:1930-1936`. Content-script listeners and `window.__IMPECCABLE_CS_LOADED__` also remain at `extension/content/content-script.js:13-15,21-42,44-70,76-95`. | Say "visual footprint teardown" rather than "fully unloaded." Add a short caveat that engine/controller listeners remain installed until page reload. |
| 02c §4, idempotency | The bridge and engine are "re-injection-safe at three levels." | During an active injected session, this is confirmed by the content-script guard (`content-script.js:13-15`), service-worker `csInjected` (`service-worker.js:59-69`), and `injectAndScan()` short-circuit (`content-script.js:103-107`). After a `remove`, though, the content script sets `injected = false` (`content-script.js:30-32`) while the old MAIN-world engine listener/globals remain (`index.mjs:1857-1936`). A later scan can append the engine file again. | Qualify the claim as active-session idempotency. For the YoinkIt transfer note, recommend an engine-level singleton/version guard or an explicit full-unload path if re-engage-after-remove must be clean. |
| 02c §2, service-worker asleep wording | "This works even while the service worker is asleep, because the content script does it directly." | The content script injects the `<script>` directly at `content-script.js:103-123`, but it enters that function from a `chrome.runtime.onMessage` scan command at `content-script.js:21-25`, sent by the service worker path at `service-worker.js:76-80`. The fallback path explicitly returns to the service worker at `content-script.js:118-121` and `service-worker.js:125-137`. | Reword to "Once the content script has received the scan command, the cheap tier does not need a second service-worker round trip; only CSP fallback does." |
| Skill/run setup | Resolver expects `audit/impeccable/source` in the current repo root. | `node skill/subslice/scripts/resolve-subslice.mjs 02c` failed in `/home/martin/.codex/worktrees/cb9d/yoinkit` with `Source root not found: audit/impeccable/source`. The same command succeeded in `/home/martin/src/perso/yoinkit`, where the source clone exists. | For future fan-out, either ensure worktrees include the source clone or teach the resolver to accept an external source root. Do not patch the report for this unless adding integration-process notes. |

## Deep Implementation Notes

- Confirmed injection ladder:
  - The service worker injects `content/content-script.js` on demand and sets `state.csInjected = true` after `chrome.scripting.executeScript` resolves (`extension/background/service-worker.js:56-69`).
  - A scan command is sent with built config via `chrome.tabs.sendMessage(tabId, { action: 'scan', config })` (`service-worker.js:76-80`).
  - The content script sets `document.documentElement.dataset.impeccableExtension = 'true'`, creates a script tag for `chrome.runtime.getURL('detector/detect.js')`, sets `script.dataset.impeccableExtension = 'true'`, sets `pendingScan = true`, and appends the tag (`extension/content/content-script.js:109-123`).
  - On `script.onerror`, the content script sends `{ action: 'inject-fallback' }` (`content-script.js:118-121`), and the service worker injects `detector/detect.js` with `world: 'MAIN'` (`service-worker.js:125-137`).
- Confirmed dual `EXTENSION_MODE` signal:
  - The engine reads `document.currentScript.dataset.impeccableExtension` or `document.documentElement.dataset.impeccableExtension` (`cli/engine/browser/injected/index.mjs:8-10`).
  - The documentElement flag is load-bearing for fallback injection because `executeScript` does not rely on the script tag carrying `dataset.impeccableExtension`.
- Confirmed ready handshake:
  - In extension mode the engine registers a `window.message` command listener and does not auto-scan (`index.mjs:1855-1912`).
  - It posts `{ source: 'impeccable-ready' }` at `index.mjs:1912`.
  - The content script flips `injected = true` and sends the pending scan only after ready (`extension/content/content-script.js:63-69`).
  - Non-extension mode schedules auto-scan after DOM ready plus 100ms (`index.mjs:1913-1927`).
- Confirmed public API surface:
  - `window.impeccableDetect`, `window.impeccableDetectAsync`, `window.impeccableScan`, `window.impeccableScanAsync`, `window.impeccableCollectVisualContrastCandidates`, `window.impeccableAnalyzeVisualContrast`, and `window.impeccableGetLastVisualContrastAnalyses` are assigned at `index.mjs:1930-1936`.
  - `window.__IMPECCABLE_CONFIG__` is written from the scan command at `index.mjs:1859-1861` and read by spotlight/design-system/disabled-rules/visual-contrast/auto-scan paths at `index.mjs:117,1286,1457,1573,1577,1914`.
- Confirmed footprint-scrubbing matrix:
  - Main element loop: skips `.impeccable-*`, `claude-` / `cic-` ids, `[id^="impeccable-live-"]`, and `body/html` at `index.mjs:1466-1476`.
  - Visual contrast candidate loop: skips `.impeccable-*`, `[id^="impeccable-live-"]`, and `body/html` at `index.mjs:658-662`.
  - Pixel-sample stack walk: skips `.impeccable-*` only at `index.mjs:1037-1040`.
  - Regex-on-HTML clone pass: removes `[id^="impeccable-live-"]` nodes before `checkHtmlPatterns(docClone.outerHTML)` at `index.mjs:1550-1558`. This happens during `collectBrowserFindings()` before new overlays are rendered by `renderBrowserFindings()`, because `scan()` calls `clearOverlays()` first (`index.mjs:1810-1814`).
- Confirmed postMessage hygiene gap:
  - Content-script outbound page commands all target `'*'` (`extension/content/content-script.js:28,31,35,38,100`).
  - Engine result/error/toggle/ready posts target `'*'` (`index.mjs:1653-1658,1663-1666,1795-1800,1870,1912`).
  - Both inbound page-message handlers do gate on `e.source === window` and a `source` discriminator (`content-script.js:45-48`, `index.mjs:1857-1858`).

## Paradigms Worth Importing

- Import the two-tier MAIN-world injection ladder, but specify the controller state machine explicitly for YoinkIt: `inject bridge -> inject __cap -> wait for cap-ready -> arm capture -> trigger real user event -> wait -> dump`. This avoids sleep-based arming and maps directly to YoinkIt's timed-capture recipe.
- Import the dual-signal extension-mode flag, but give YoinkIt a per-injection nonce in addition to `source` so results from old injections or other same-window listeners cannot be mistaken for the active capture session.
- Import the self-scrubbing idea as a matrix, not a slogan. YoinkIt needs the exclusion set in `scan(root)`, frame sampling, `dump()`, DOM serialization, selector discovery, and any `outerHTML` regex pass. Include YoinkIt UI prefixes plus known neighboring tool prefixes such as `claude-`, `cic-`, and any agent-browser chrome.
- Separate "visual teardown" from "engine unload" in YoinkIt. A `cap-remove-overlays` command can clear tool chrome; a true `cap-unload` needs to remove listeners, observers, globals, pending timers, and any message nonce/session state. If full unload is not worth it, keep an engine-level singleton/version guard and make re-engagement idempotent.
- Keep Impeccable's page-engine ignorance of `chrome.*`. The content script as the only component with a foot in both worlds is the clean transfer pattern for YoinkIt's extension UI driving `window.__cap`.

## Link And Citation Checks

- Automated markdown link check:
  - Leaf `02c-injection-and-main-world.md`: 41 relative links, 0 missing after remapping `../../source/` to `/home/martin/src/perso/yoinkit/audit/impeccable/source`.
  - Parent `02-chrome-extension.md`: 72 relative links, 0 missing after the same source remap.
- Internal companion links in the leaf exist in this worktree: `02b-messaging-and-survival.md` and `02d-devtools-surfaces.md`.
- Key source anchors confirmed against the primary source clone: `extension/content/content-script.js:5-7,13-15,21-25,63-69,97-123`; `extension/background/service-worker.js:56-80,125-137,153-168,241-266`; `cli/engine/browser/injected/index.mjs:8-10,117,658-662,1037-1040,1286,1455-1476,1550-1558,1770-1777,1810-1814,1855-1936`.
- Stale or misleading anchor: the report's `index.mjs:1039` citation is real, but the prose attached to it is broader than the code. That line only proves the `.impeccable-*` skip in the pixel-sample stack walk, not the `impeccable-live-*` skip.
- Environment caveat: `../../source/...` links are structurally correct for the audit tree, but they are broken in `/home/martin/.codex/worktrees/cb9d/yoinkit` until `audit/impeccable/source` is present.

## Open Questions

- The leaf's explanation that MAIN world is required because `getComputedStyle`, `document.styleSheets.cssRules`, `elementsFromPoint`, and canvas sampling see only the page's "real" world is supported by the source comment at `extension/content/content-script.js:5-7` as author intent. If the final report wants this as a normative Chrome-extension-platform claim, verify the exact isolated-world/CSSOM semantics against Chrome docs.
- Should the integration report call out the re-engage-after-remove behavior as an Impeccable bug, or only as a YoinkIt hardening lesson? Source evidence shows the old engine is not fully unloaded; whether this causes user-visible duplicate results depends on how often users close DevTools and reopen without reloading.
- Should the subslice resolver grow an optional source-root argument for fan-out worktrees? This run had to verify against the primary checkout because the current worktree lacks the source clone.
