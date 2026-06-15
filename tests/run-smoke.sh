#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="motion-smoke-$$"
SERVER_LOG="$(mktemp)"
PORT="$(
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
URL="http://127.0.0.1:${PORT}/tests/fixtures/basic-motion.html"

cleanup() {
  agent-browser --session "$SESSION" close --all >/dev/null 2>&1 || true
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$SERVER_LOG"
}
trap cleanup EXIT

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
sleep 0.4

agent-browser --session "$SESSION" --init-script "$ROOT/extension/capture-animation.js" open "$URL" >/dev/null

SMOKE_JS='
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const checks = {};
  const samples = {};

  function check(name, condition, detail = "") {
    checks[name] = Boolean(condition);
    if (!condition) throw new Error(detail ? `${name}: ${detail}` : name);
  }

  async function captureOn(selector, mutate, waitMs = 650) {
    window.__cap.on(selector, { trigger: "manual" });
    await frame();
    mutate();
    await sleep(waitMs);
    return window.__cap.dump();
  }

  try {
    document.querySelector("#multi").classList.remove("active");
    await sleep(80);
    const multi = await captureOn("#multi", () => {
      document.querySelector("#multi").classList.add("active");
    });
    const multiFinding = multi.findings[0];
    const multiProps = Object.keys(multiFinding.properties || {});
    samples.multiProps = multiProps;
    check("multi transform preserved", multiProps.includes("transform"));
    check("multi opacity preserved", multiProps.includes("opacity"));
    check("multi filter preserved", multiProps.includes("filter"));

    document.querySelector("#stagger").classList.remove("active");
    await sleep(120);
    const stagger = await captureOn("#stagger", () => {
      document.querySelector("#stagger").classList.add("active");
    }, 900);
    samples.staggerFindings = stagger.findings.length;
    samples.staggerSummary = stagger.stagger;
    check("stagger keeps sibling findings", stagger.findings.length === 4, `${stagger.findings.length}`);
    check("stagger has summary metadata", stagger.stagger && stagger.stagger.items === 4);
    check("stagger has no synthetic note finding", !stagger.findings.some(f => f.note));

    document.querySelectorAll(".duplicate").forEach(el => el.classList.remove("active"));
    await sleep(80);
    const duplicate = await captureOn(".duplicate", () => {
      document.querySelectorAll(".duplicate").forEach(el => el.classList.add("active"));
    }, 550);
    const duplicateFinding = duplicate.findings[0];
    samples.duplicateLocator = duplicateFinding.locator;
    check("duplicate rendered match selected", duplicateFinding.locator.visibleMatchCount === 1);
    check("duplicate ambiguity counted", duplicateFinding.locator.matchCount === 2);
    check("duplicate unique selector exists", Boolean(duplicateFinding.locator.uniqueSelector));

    document.querySelector("#accordion").classList.remove("open");
    await sleep(80);
    const accordion = await captureOn("#accordion-panel", () => {
      document.querySelector("#accordion").classList.add("open");
    }, 650);
    samples.accordionProps = accordion.findings.map(f => Object.keys(f.properties || {}));
    check("accordion height captured", accordion.findings.some(f => f.properties && f.properties.height));

    const sprite = await captureOn("#sprite", () => {}, 750);
    const spriteFinding = sprite.findings[0];
    samples.spriteType = spriteFinding && spriteFinding.type;
    check("sprite loop detected", Boolean(spriteFinding && (
      spriteFinding.type === "css-sprite" ||
      (spriteFinding.properties && spriteFinding.properties.backgroundPosition &&
       spriteFinding.properties.backgroundPosition.type === "css-sprite")
    )));

    return { ok: true, checks, samples };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      checks,
      samples,
      lastSummary: window.__capLast && window.__capLast.summary
    };
  }
})()
'

RESULT="$(agent-browser --session "$SESSION" eval "$SMOKE_JS")"
printf '%s\n' "$RESULT" | jq -e '.ok == true and ([.checks[]] | all(. == true))' >/dev/null
printf '%s\n' "$RESULT" | jq '{ok, checks, samples}'
