# YoinkIt Contract

This is the procedural contract for YoinkIt runs. The architecture explains why
the product exists and what it is trying to preserve. This contract defines what
every agent, helper script, and generated artifact must obey.

If a skill prompt, helper note, or older scratch doc conflicts with this file,
this file wins.

## Inheritance Rule

YoinkIt inherits as much rigor as possible from `clone-app-pat-pro`, because that
workflow is proven to work. Relax the clone-app pattern only when it directly
conflicts with YoinkIt's product decisions.

Keep by default:

- explicit stage inputs and outputs
- fixed artifact paths
- evidence rules for every claim
- binary gates
- coverage manifests
- `null + reason` for unknowns
- hard human check-ins at gate boundaries
- measured convergence loops
- no silent warnings

Reject or relax where needed:

- no source-code, framework, or library fidelity
- no source architecture copying
- no pixel-diff gate for motion
- no pretending uncertain motion is more certain than the evidence supports

## Run Layout

Each yoink run writes to a single run directory. The exact root can be configured,
but the structure inside it is fixed.

```text
yoink-runs/{slug}/
├── 00-config.json
├── page-model.json
├── 01-recon/
│   ├── page-state.json
│   ├── viewport-manifest.json
│   └── source-metadata.json
├── 02-static-map/
│   ├── measurements.json
│   ├── assertions.json
│   ├── coverage.md
│   ├── crops/
│   └── assets/
├── 03-motion-scout/
│   ├── motion-candidates.json
│   ├── coverage.md
│   └── assertions.json
├── 04-map-report/
│   ├── index.html
│   └── gate.json
├── 05-capture/
│   ├── passes/
│   │   └── pass-001/
│   │       ├── pass.json
│   │       ├── clips/
│   │       └── crops/
│   └── results.json
├── 06-spec/
│   └── spec.json
└── 07-implement/
    ├── architecture/
    │   ├── file-tree.md
    │   ├── component-map.md
    │   ├── motion-map.md
    │   └── token-map.md
    ├── static-assertions.json
    ├── motion-assertions.json
    └── qa/
```

Earlier prototype paths such as `map.json`, `manifest.proposed.json`,
`animations.json`, and `report.md` are salvage material, not the contract.

`page-model.json` is the canonical artifact. Stage directories hold evidence,
assertions, projections, and logs that update or derive from it. No stage owns a
second copy of the Page model.

The Report and Spec are projections of `page-model.json`. They are never
hand-authored in parallel.

Report Region placeholder positions and dimensions are derived from Region
geometry in `page-model.json`. The Report must not store separate geometry or
sizing facts that can drift from the Page model.

`00-config.json` is the shared interface between the agent skill and the
deterministic CLI. Skill arguments and CLI flags both compile into this file
before stage commands run.

It is also shared by `implement`. `06-spec/spec.json` is the main implementation
input, but operational settings such as output path, target stack, gate
tolerances, and check-in policy live under an `implement` section of the same run
config.

Minimum shape:

```json
{
  "schemaVersion": 1,
  "targetUrl": "https://example.com",
  "scope": "page",
  "viewports": [
    { "id": "desktop", "width": 1280, "height": 800 },
    { "id": "mobile", "width": 390, "height": 844 }
  ],
  "primaryViewport": "desktop",
  "outputDir": "./out/example",
  "yoink": {
    "mode": "observe"
  },
  "implement": {
    "targetStack": "house",
    "projectPath": "./out/example",
    "checkIns": true
  }
}
```

The skill and CLI may accept friendly shorthand, but the resolved
`00-config.json` stores explicit viewport dimensions. Map v0 uses those
dimensions to measure Region geometry, responsive presence, crops, and Report v0
Region placeholder sizing.

Minimum `page-model.json` v0 shape:

```json
{
  "schemaVersion": 1,
  "source": { "url": "https://example.com" },
  "viewports": [
    { "id": "desktop", "width": 1280, "height": 800 }
  ],
  "pages": {
    "home": {
      "path": "/",
      "dimensions": {
        "desktop": { "scrollWidth": 1280, "scrollHeight": 4200 }
      },
      "regions": []
    }
  },
  "captures": [],
  "notes": [],
  "exceptions": []
}
```

Map v0 writes ordered Regions into the page's `regions` list. The capture,
notes, and exceptions buckets exist in the model from the start, but Capture
passes fill them later.

## CLI Boundary

The CLI is a deterministic stage runner. It reads `00-config.json`, reads and
writes the fixed run artifacts, and executes named stages such as `init`, `map`,
`report`, `map-gate`, `capture`, `merge-pass`, `spec`, and `validate`.

The CLI must not make product judgment calls:

- what part of the source is worth capturing
- whether a Report is good enough
- whether a `verify` motion is acceptable
- whether to waive a gate finding
- whether the yoink is complete

Those decisions belong to the agent session and the human gate.

The current `bin/yoinkit` is prototype material. Implementation work may salvage
working code from it, but must not preserve its monolithic shape or any
pre-contract command semantics that conflict with the Page model, Map Gate,
Report view modes, or deterministic stage-runner boundary.

The first stage-runner slice exposes each pre-gate stage directly:

```text
yoinkit init <url>
yoinkit recon <run-dir>
yoinkit static-map <run-dir>
yoinkit motion-scout <run-dir>
yoinkit map-report <run-dir>
yoinkit map-gate <run-dir>
```

It also exposes one convenience command:

```text
yoinkit map <run-dir>
```

`yoinkit map` runs `recon -> static-map -> motion-scout -> map-report`, then
stops before `map-gate` so the human can review Report v0. `map-gate` is a pure
validator and recorder: it accepts an explicit decision from the agent session
after human review, checks that the required assertions and coverage allow that
decision, and writes `04-map-report/gate.json`. It does not decide approval
itself.

Minimum decision commands:

```text
yoinkit map-gate <run-dir> --approve
yoinkit map-gate <run-dir> --reject
yoinkit map-gate <run-dir> --approve-exception <exception-id>
```

## Stage Spine

```text
Recon -> Static Map -> Motion Scout -> Map Report -> Map Gate -> Capture -> Spec -> Implement
```

The agent may run deterministic helper commands inside a stage. It must not cross
a gate boundary until the gate passes or the human explicitly approves a recorded
exception.

`yoink` and `implement` are separate visible skills. A convenience handoff may
start `implement` after `yoink` produces Report + Spec, but implementation still
runs as a separate build context.

## Dependency-Aware Gates

Gates block only the downstream stages that depend on the missing evidence.
Stages may proceed when their prerequisites are met, as long as lower-confidence
items and gaps are carried forward honestly.

- The **Map Gate** is required before Capture and Implement because both depend
  on spatial/static truth.
- Full Capture completeness is required before claiming the yoink complete, but
  it is not required before starting an implementation draft.
- `implement` may start after the Map Gate passes. It consumes measured motion
  tightly, carries `verify` motion as loose/human-review work, and records gaps
  instead of inventing certainty.
- If Capture completeness has not been approved, `implement` produces a
  **draft implementation**. Once Capture is approved complete, or once the
  remaining verify items and gaps are resolved enough for final review, the build
  can become a **candidate implementation**.

## Evidence Rules

Every claim that affects a gate must carry evidence.

- Static facts come from DOM, CSSOM, computed styles, screenshots, crops, or
  downloaded bytes.
- Motion facts come from the capture engine's sampled frames, event stream,
  library registry, Clips, or explicit human Notes.
- Human judgment belongs in Notes, importance, gate approval, and exceptions.
  It must not replace measured mechanics.
- Unknowns are recorded as `null + reason`. They are never silently dropped and
  never invented from memory.
- When sources conflict, prefer measured runtime facts over screenshots, and
  prefer source-like visual evidence only as supporting context.

## Recon Stage

Recon proves the source page can be reached and described at the configured
viewports before any Page model structure is authored.

Recon must write:

- `01-recon/page-state.json`
- `01-recon/viewport-manifest.json`
- `01-recon/source-metadata.json`

Recon records at least:

- final URL after redirects
- readiness and blocker status
- viewport dimensions actually used
- page dimensions per viewport
- title and source metadata
- framework and library hints where detectable
- dominant iframe facts, including same-origin retargeting or cross-origin
  blockers
- scroll and lazy-load readiness notes

Recon must not create Regions, Region placeholders, or motion candidates. Those
begin in Static Map and Motion Scout.

## Map Stage

Map builds the Page model skeleton through two pre-human passes:

- **Static Map** proves the static scaffold: Region identity, boxes, layout,
  colors, typography, assets, and Region placeholder shape and size.
- **Motion Scout** discovers likely motion targets from registries, CSS
  transitions, keyframes, split reveals, hover affordances, loops, and scroll
  triggers. It writes candidates for Capture; it does not write measured motion
  facts.

Map is place-first: Regions are ordered top-to-bottom, with captures nested later
inside their spatial home.

Static Map is YoinkIt's extraction-equivalent layer: it records measured
per-Region facts. It must not synthesize global design tokens, infer component
architecture, or decide how the implementation should be decomposed. Those
decisions belong to `implement`.

Static Map `static.colors`, `static.typography`, and `static.assets` are evidence
lists, not tokenized design-system fields. They record measured values, selectors,
asset paths, intrinsic dimensions, and evidence methods. They must not contain
implementation tokens such as `--color-primary` or component names such as
`HeroTitle`.

Motion Scout writes candidates in two shapes:

- `03-motion-scout/motion-candidates.json` is the flat runnable checklist for
  Capture.
- `page-model.json` stores Region-local candidate references so the Report can
  show each candidate in its spatial home.

Motion candidates are leads, not measurements. They may record a likely trigger,
source selector, Region id, and evidence source. They must not record measured
duration, easing, from/to values, or frame timelines.

Map must write:

- `page-model.json`
- `02-static-map/measurements.json`
- `02-static-map/assertions.json`
- `02-static-map/coverage.md`
- `02-static-map/crops/`
- `03-motion-scout/motion-candidates.json`
- `03-motion-scout/assertions.json`
- `03-motion-scout/coverage.md`
- `04-map-report/index.html` as Report v0

`02-static-map/coverage.md` is the human-readable checklist for Static Map
coverage. `02-static-map/assertions.json` is the machine-readable gate input
that `map-gate` evaluates. They cover the same Map facts from different angles:
human scan versus deterministic validation.

`03-motion-scout/coverage.md` and `03-motion-scout/assertions.json` follow the
same split for candidate discovery. They answer whether Motion Scout inspected
the obvious motion sources before human review: registries, CSS transitions,
CSS keyframes, split reveals, hover affordances, loops, and scroll-trigger
sources. They gate discovery coverage, not motion fidelity.

Coverage rows include:

- area
- whether it is required
- status
- evidence
- reason when missing, out of scope, or exceptional

Assertion rows include:

- stable id
- kind
- required flag
- status
- evidence references
- failure or exception reference when applicable

Each Region must have:

- stable id
- human-readable name
- order within the page
- per-viewport rect and scroll-Y
- per-viewport presence
- Region placeholder dimensions derived from the measured Region rect
- crop path or `null + reason`
- static visual evidence where available
- source selectors or `null + reason`
- motion candidates or an empty list

Minimum Region v0 shape:

```json
{
  "id": "region-hero",
  "name": "Hero",
  "order": 1,
  "viewports": {
    "desktop": {
      "presence": "present",
      "rect": { "x": 0, "y": 0, "width": 1280, "height": 760 },
      "scrollY": 0,
      "placeholder": { "width": 1280, "height": 760 },
      "crop": { "path": "02-static-map/crops/region-hero.desktop.png" }
    }
  },
  "static": {
    "colors": [],
    "typography": [],
    "assets": [],
    "layout": {}
  },
  "source": {
    "selectors": ["main > section.hero"],
    "evidence": []
  },
  "motionCandidates": [],
  "unknowns": []
}
```

The Region id is the stable identity across viewports. Presence, rect, scroll-Y,
placeholder dimensions, and crop are per-viewport facts.

## Map Gate

The Map Gate is binary. It passes only when all of the following are true:

- every required Map assertion passes
- every required Static Map coverage row is complete
- every required Motion Scout coverage row is complete
- every unknown has `null + reason`
- every exception is explicitly human-approved and recorded
- the human approves Report v0

Canonical exceptions live in `page-model.json` under `exceptions[]` so Capture,
Spec, and Implement inherit them automatically. `04-map-report/gate.json` is the
Map Gate decision record: it records the gate result, assertion summary, coverage
summary, unknowns, human approval, and the ids of approved exceptions. It does
not own a second copy of the exceptions.

`map-gate` must fail an approval when required assertions fail or coverage rows
are incomplete unless each blocking item has already been marked out of scope or
approved as an exception. The command records explicit approval or rejection; it
does not infer either from the Report.

Map Gate can pass with zero motion candidates when Motion Scout completed its
discovery checklist and found no applicable motion sources. It cannot pass when
Motion Scout simply failed to inspect required sources such as CSS transitions,
keyframes, hover affordances, registries, loops, or scroll-trigger clues.

Map assertions cover at least:

- important visible sections are represented as Regions
- Region rects match the source within the configured tolerance
- Report v0 Region placeholders match the measured Region dimensions
- crops align with the source Region
- scroll order is correct
- responsive presence is correct for the mapped viewports
- Region names are stable enough for capture and implementation handoff
- Motion Scout candidates are recorded as candidates, not measured motion facts

There are no agent-controlled warnings. A finding is one of:

- **Required assertion failure**: blocks the gate.
- **Out of scope**: excluded before the gate with a reason.
- **Human-approved exception**: allowed only when recorded in the Page model and
  the gate artifact.
- **Info**: visible note only, not part of the gate.

## Report

The Report is the human-facing projection of the Page model. It is written to
disk and opened in a browser. It does not re-enter agent context unless the human
or agent explicitly reads a small part of it.

Report v0 must support three view modes:

- **Source mode**: source-like crops and measured static visuals first, exact
  Region positions, correctly sized Region placeholders, minimal debug overlay.
  It answers whether the static scaffold resembles the source.
- **Region mode**: artificial tints, inset non-layout-affecting borders, labels,
  hover outlines, and tooltips. It answers whether segmentation is correct.
- **Gate mode**: missing, uncertain, failed, or blocking items emphasized. For
  Report v0, this includes failed assertions, incomplete coverage rows, unknowns,
  unapproved exceptions, and motion candidates that need human attention. It
  answers what blocks Capture.

Edits made through the Report write back to `page-model.json`. They do not
decorate the HTML only.

After `implement` runs, the Report also shows implementation status per Region
and per motion item. It should surface at least:

- Map status
- Capture status and Confidence
- Static Fidelity assertion status
- motion assertion status
- open verify items
- gaps and human-approved exceptions
- draft or candidate implementation state

The Report is also a re-entry point. A follow-up command may resume from the run
or Report path and start an Improve pass focused on the current failures and
gaps, rather than restarting the whole yoink.

The visible command for this is:

```text
implement --improve <run-dir>
```

## Capture Stage

Capture enriches Regions in the Page model. It runs in automated mode and observe
mode. A capture pass writes an isolated pass directory, then the agent merges the
pass into `page-model.json`.

Each pass must record:

- mode: `automated` or `observe`
- viewport
- Region ids touched
- Trigger evidence where measured
- captured motion items
- Confidence per item
- Clips and crop paths
- Notes
- unknowns as `null + reason`

Trigger mechanics are measured. Notes carry human intent, not mechanical facts
the engine can measure.

## Spec

`06-spec/spec.json` is the machine-facing projection of `page-model.json`. It is
compact and agent-ingestable. It references Clip paths but does not inline
frames.

The Spec must preserve:

- Region identity and viewport applicability
- Static Fidelity facts needed by implementation
- measured motion facts
- Confidence
- human Notes that affect implementation judgment
- recorded exceptions

## Implement Stage

`implement` consumes `06-spec/spec.json` first. The Report and Clips are
supporting evidence. The implementation skill inherits clone-app's build rigor
where it does not conflict with YoinkIt.

The default `implement.targetStack` is `house`: React, Bun, Vite, Lenis, GSAP,
and CSS Modules. Lenis is default-on: calibrate it toward measured source smooth
scroll behavior when evidence exists, otherwise use the House Lenis settings.
Disable it only by explicit config override or human-approved exception. A
project may override the stack explicitly, for example to target Astro.

CSS-authored motion stays CSS when it can be ported cleanly and faithfully:
transitions, keyframes, and simple local animations should not be rewritten into
GSAP for ceremony. GSAP is the default for Signature motion that needs an
animation runtime: choreography, scroll-triggered motion, timelines, staged
reveals, and complex hover sequences. Do not choose Framer Motion, Anime.js, or
source-site motion libraries unless the config explicitly overrides the House
stack.

The source site's framework is evidence about the source, not an implementation
target.

Required shape:

- permanent implement references inside this repo define the standard House
  architecture and build rules
- run a minimal per-run Architecture stage before build work starts
- the Architecture stage writes `07-implement/architecture/file-tree.md`,
  `07-implement/architecture/component-map.md`,
  `07-implement/architecture/motion-map.md`, and
  `07-implement/architecture/token-map.md`
- the Architecture/Foundation work extracts an editable implementation token
  layer from the Spec, covering color, typography, spacing, assets, and motion
  variables where evidence supports them
- the built app exposes the implementation token layer through the House stack's
  normal control surface, such as global CSS custom properties and motion
  variables, instead of scattering hard-coded values through components
- document the generated file tree before implementation work fans out
- build foundation first: tokens, layout shell, assets, shared components
- build pages or sections after the foundation
- use CSS Modules for component styling, layout rules, responsive rules, state
  selectors, and local animation classes
- use global CSS variables for tokens and House stack variables
- use inline styles only for dynamic runtime values or assigning CSS custom
  properties such as measured delays
- keep static visual assertions tight
- keep motion assertions confidence-aware
- keep code architecture clean and remixable
- keep compile, lint, and test checks green where available

Implementation gates are tiered:

- **Static Fidelity gate**: strict measured assertions for layout, colors,
  typography, assets, states, responsive geometry, and key dimensions.
- **Motion gate**: measured spec diff where confident, looser verify path where
  confidence is lower, with Clips and human judgment as supporting evidence.
- **Architecture gate**: clean idiomatic components, clear props, no source
  framework or source architecture fidelity.
- **Build gate**: the target project compiles, and configured lint/tests pass.

## Improve Pass

An Improve pass starts from an existing run directory. The agent reads
`page-model.json`, `06-spec/spec.json`, implementation QA artifacts, and the
Report status, then works with the human to choose the next focused target.

Valid targets include:

- fix static assertion failures
- implement or improve a measured motion
- resolve a `verify` motion item
- run another capture pass for a gap
- update a human-approved exception
- promote a draft implementation to candidate

The pass must preserve the same evidence rules and update the Page model, Report,
Spec, and implementation QA artifacts as appropriate.

## Terminal States

Each major stage ends in one of these states:

- `PASS`: the gate passed.
- `BLOCKED`: an external or missing-input condition prevents honest progress.
- `STUCK`: repeated attempts do not improve the measured failure count.
- `CEILING`: the configured attempt budget was reached.

On failure states, write an escalation artifact with:

- stage
- failed assertions or incomplete coverage rows
- unknowns
- exceptions requested but not approved
- attempts made
- recommended next action

## Human Check-Ins

Human check-ins are hard stops at gate boundaries. The user can approve, revise,
record an exception, or stop. The agent must not continue past a gate while
required assertions fail or unapproved exceptions remain.
