#!/usr/bin/env node
'use strict';
/*
 * repair-step.js — the skill's apply+re-measure+record primitive for ONE repair
 * attempt. The skill (the agent) owns the loop (which failures, which retries,
 * the budget); this script is the deterministic bridge that lets the ENGINE
 * re-measure a model-proposed repair. It NEVER measures motion or invents a
 * status — every duration/easing/from-to/status comes from the engine via
 * `bin/motion-decompile capture`. The model's §3 output is consumed for
 * targeting only; success is machine-checked with the tool's own meetsSuccess.
 *
 * It reuses the tool's exported helpers verbatim (applyRepair, validateRepairOutput,
 * meetsSuccess, resultTriple, REPAIR_DEFAULTS) so the apply + success contract is
 * byte-identical to the in-tool Part 6 loop. The only thing the skill adds is
 * orchestration around it.
 *
 * Subcommands:
 *   apply    --run R --manifest M --index I --id ID --output OUT.json --attempt N
 *            Route the §3 output:
 *              - invalid                -> record terminal(provider_error), no measure
 *              - terminal_give_up       -> record terminal(<cause>),      no measure
 *              - confidence < floor     -> record unrepaired(low-conf),   no measure
 *              - actionable + confident -> applyRepair -> a FRESH single-capture
 *                                          `capture` run (engine measures, M1 by
 *                                          construction) -> meetsSuccess -> record
 *            Updates <run>/capture-results.json in place (id-keyed, §6 schema) and
 *            prints a one-line verdict JSON on stdout for the skill's loop control.
 *
 *   terminal --run R --index I --id ID --attempt N --cause C [--diagnosis D]
 *            Record a skill-decided terminal verdict (e.g. repeated-identical ->
 *            genuinely_inert/needs_human) without measuring. §6 schema.
 *
 * Tool output is captured to the run log; this script's ONLY stdout is the
 * verdict JSON, so the skill can parse it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Locate the repo + the tool (robust to being run from the repo or a symlink
// into ~/.claude/skills; the skill is repo-bound and run from the repo root). ──
function findTool() {
  const candidates = [
    process.env.MOTION_DECOMPILE_BIN,
    path.join(process.cwd(), 'bin', 'motion-decompile'),
    path.resolve(__dirname, '..', '..', 'bin', 'motion-decompile'),
  ].filter(Boolean);
  const found = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  if (!found) {
    fail('cannot locate bin/motion-decompile — run from the motion-decompiler repo root or set MOTION_DECOMPILE_BIN');
  }
  return found;
}

function fail(msg) {
  process.stderr.write(`repair-step: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return out;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// Update one result (by id) in <run>/capture-results.json and persist. `mut` is
// applied to the matched result object; returns the updated result.
function patchResult(runDir, id, mut) {
  const file = path.join(runDir, 'capture-results.json');
  const doc = readJson(file);
  const result = (doc.results || []).find(r => r.id === id);
  if (!result) fail(`no result with id "${id}" in ${file}`);
  mut(result);
  writeJson(file, doc);
  return result;
}

// The §6 repair block, initialised once per capture, accumulating attempts.
function ensureRepairBlock(result) {
  if (!result.repair) {
    result.repair = {
      attempted: true,
      failureCause: result.cause || null,   // the ORIGINAL Part 1 bucket, for metrics
      attempts: [],
      winningAction: null,
      outcome: 'unrepaired',
      terminalCause: null,
    };
  }
  result.repair.attempted = true;
  if (result.repair.failureCause == null) result.repair.failureCause = result.cause || null;
  return result.repair;
}

function verdict(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }

// ── apply ────────────────────────────────────────────────────────────────────
function cmdApply(args, tool, m) {
  const runDir = path.resolve(req(args, 'run'));
  const manifestFile = path.resolve(req(args, 'manifest'));
  const index = Number(req(args, 'index'));
  const id = String(req(args, 'id'));
  const outputFile = path.resolve(req(args, 'output'));
  const attempt = Number(args.attempt || 1);

  const manifest = readJson(manifestFile);
  const capture = (manifest.captures || [])[index];
  if (!capture) fail(`manifest has no capture at index ${index}`);
  const type = String(capture.type || 'manual').toLowerCase();

  let output;
  try { output = readJson(outputFile); }
  catch (e) { return recordTerminal(runDir, id, attempt, 'provider_error', `unreadable output: ${e.message}`, null, verdict); }

  const validated = m.validateRepairOutput(output);
  if (!validated.valid) {
    // No trustworthy confidence on an unparseable/invalid output.
    return recordTerminal(runDir, id, attempt, 'provider_error', validated.error, null, verdict);
  }
  const repair = validated.repair;
  const kind = repair.action.kind;
  const confidence = repair.confidence;

  // Provider-chosen terminal: honest STOP, no measure, no budget on a recapture.
  if (kind === 'terminal_give_up') {
    const cause = (repair.action.terminalCause && ['genuinely_inert', 'genuinely_absent', 'cross_origin_iframe', 'needs_human', 'provider_error'].includes(repair.action.terminalCause))
      ? repair.action.terminalCause : 'needs_human';
    return recordTerminal(runDir, id, attempt, cause, repair.diagnosis, confidence, verdict);
  }

  // Low-confidence: don't spend a re-measure on a guess (design §4.2).
  if (confidence < m.REPAIR_DEFAULTS.confidenceFloor) {
    patchResult(runDir, id, (result) => {
      const rb = ensureRepairBlock(result);
      rb.attempts.push({ action: kind, params: repair.action, confidence, resultStatus: 'skipped-low-confidence', resultCause: null });
      rb.outcome = 'unrepaired';
      result.lowConfidenceDiagnosis = repair.diagnosis || null;
    });
    return verdict({ id, attempt, kind, measured: false, converged: false, outcome: 'unrepaired', terminalCause: null, lowConfidence: true, confidence });
  }

  // ── Actionable: clone, (faithfully) carry the group's setup action ahead of
  // any precondition, then let the ENGINE re-measure a FRESH single capture. ──
  const cloned = m.applyRepair(capture, type, repair.action);
  prependGroupSetup(cloned, type, manifest);

  const subRun = path.join(runDir, 'repair', `apply-${id}-att${attempt}`);
  fs.mkdirSync(subRun, { recursive: true });
  // Carry map.json so the engine's failure classifier keeps Part 1 context if the
  // repair still fails (useful for the next attempt's diagnosis). Best effort.
  try {
    const mapSrc = path.join(runDir, 'map.json');
    if (fs.existsSync(mapSrc)) fs.copyFileSync(mapSrc, path.join(subRun, 'map.json'));
  } catch (e) { /* non-fatal */ }

  const subManifest = {
    url: cloned.url || manifest.url,
    viewport: manifest.viewport,
    captureStrategy: manifest.captureStrategy || 'reuse-page',
    captureGroups: manifest.captureGroups || manifest.groups || undefined,
    initialWaitMs: manifest.initialWaitMs,
    captureInitialWaitMs: manifest.captureInitialWaitMs,
    captures: [cloned],
  };
  const subManifestFile = path.join(subRun, 'apply-manifest.json');
  writeJson(subManifestFile, subManifest);

  // The ENGINE measures. Tool stdout/stderr go to the run log, never to ours.
  const run = spawnSync(tool, ['capture', subRun, subManifestFile], { encoding: 'utf8', env: process.env });
  const log = `\n[repair-step apply ${id} att${attempt}] ${kind}\n${run.stdout || ''}${run.stderr || ''}\n`;
  try { fs.appendFileSync(path.join(runDir, 'run.log'), log); } catch (e) { /* ignore */ }
  if (run.status !== 0 && !fs.existsSync(path.join(subRun, 'capture-results.json'))) {
    return recordTerminal(runDir, id, attempt, 'needs_human', `capture sub-run failed (exit ${run.status})`, confidence, verdict);
  }

  // Read the engine's verdict (status) + the moved selectors from its timeline.
  const subResults = readJson(path.join(subRun, 'capture-results.json'));
  const engine = (subResults.results || [])[0] || { status: 'error' };
  const engineStatus = engine.status;
  const timelineFile = path.join(subRun, 'timelines', `${cloned.id || id}.json`);
  let movedSelectors = [];
  let timeline = null;
  try {
    timeline = readJson(timelineFile);
    movedSelectors = Array.isArray(timeline.findings) ? timeline.findings.map(f => f && f.selector).filter(Boolean) : [];
  } catch (e) { /* empty/error captures may have no findings */ }

  // Machine-checked success — the tool's OWN criterion logic, never self-report.
  const converged = m.meetsSuccess({ status: engineStatus, movedSelectors }, repair.successCriterion || { expect: 'moved' });
  const triple = m.resultTriple({ status: engineStatus, cause: engine.cause, causeSignals: engine.causeSignals });

  const updated = patchResult(runDir, id, (result) => {
    const rb = ensureRepairBlock(result);
    rb.attempts.push({ action: kind, params: repair.action, confidence, resultStatus: engineStatus, resultCause: engine.cause || null });
    if (converged) {
      // The engine's measured verdict becomes the capture's status. Provenance
      // records HOW it was reached; it never overrides the measured status.
      result.status = engineStatus;
      result.origin = 'after-repair';
      result.findings = (timeline && Array.isArray(timeline.findings)) ? timeline.findings.length : (engine.findings || 0);
      result.summary = (timeline && timeline.summary) || result.summary;
      // Promote the repaired timeline into the main run so assemble/report use it.
      const destRel = path.join('timelines', `${id}.json`);
      try {
        if (timeline) writeJson(path.join(runDir, destRel), timeline);
        result.timelineRef = destRel;
      } catch (e) { /* keep prior ref on copy failure */ }
      rb.winningAction = kind;
      rb.outcome = 'ok-after-repair';
      rb.terminalCause = null;
    } else {
      rb.outcome = 'unrepaired';   // the skill may retry (Phase C) or terminalize
    }
  });

  verdict({
    id, attempt, kind, measured: true, converged,
    status: engineStatus, movedSelectors, resultTriple: triple,
    outcome: updated.repair.outcome, terminalCause: null, confidence,
    occludedBy: (engine.causeSignals && engine.causeSignals.occludedBy) || null,
    cause: engine.cause || null,
  });
}

// Record a terminal verdict (no measure). Shared by provider-terminal and the
// skill's repeated-identical/exhausted terminalization.
function recordTerminal(runDir, id, attempt, cause, diagnosis, confidence, emit) {
  patchResult(runDir, id, (result) => {
    const rb = ensureRepairBlock(result);
    rb.attempts.push({ action: 'terminal_give_up', params: { terminalCause: cause, rationale: diagnosis || null }, confidence: confidence == null ? null : confidence, resultStatus: null, resultCause: null });
    rb.outcome = 'terminal';
    rb.winningAction = null;
    rb.terminalCause = cause;
    if (diagnosis) result.terminalDiagnosis = String(diagnosis);
  });
  emit({ id, attempt, kind: 'terminal_give_up', measured: false, converged: false, outcome: 'terminal', terminalCause: cause, confidence: confidence == null ? null : confidence });
}

function cmdTerminal(args) {
  const runDir = path.resolve(req(args, 'run'));
  const id = String(req(args, 'id'));
  const attempt = Number(args.attempt || 1);
  const cause = String(req(args, 'cause'));
  recordTerminal(runDir, id, attempt, cause, args.diagnosis || null, args.confidence == null ? null : Number(args.confidence), verdict);
}

// Faithful with recaptureForRepair: run the capture group's setupAction (e.g. an
// intro-overlay dismissal) BEFORE a precondition. The default planner group has
// none, so this is usually a no-op; included so a manifest that defines one stays
// correct. Stateful repairs (precondition/scroll) already carry fresh:true.
function prependGroupSetup(cloned, type, manifest) {
  const group = cloned.group || (type === 'click' || type === 'dblclick' ? 'stateful-interactions' : 'main-page-after-intro');
  const groups = manifest.captureGroups || manifest.groups || {};
  const gc = (groups && typeof groups === 'object' && groups[group]) || {};
  const setup = gc.setupAction || gc.action;
  if (!setup) return;
  const steps = Array.isArray(setup) ? setup.slice() : [setup];
  if (!steps.length) return;
  // Only meaningful when the repair re-opens a fresh page; otherwise the live
  // first-try page already ran setup. applyRepair sets fresh for stateful kinds.
  if (cloned.fresh !== true) return;
  cloned.beforeAction = steps.concat(Array.isArray(cloned.beforeAction) ? cloned.beforeAction : (cloned.beforeAction ? [cloned.beforeAction] : []));
}

function req(args, name) {
  if (args[name] === undefined || args[name] === true) fail(`missing --${name}`);
  return args[name];
}

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const tool = findTool();
  const m = require(tool);
  if (sub === 'apply') cmdApply(args, tool, m);
  else if (sub === 'terminal') cmdTerminal(args);
  else fail(`unknown subcommand "${sub}" (use: apply | terminal)`);
}

main();
