/* ============================================================================
 * capture-animation.js  —  web animation decompiler (Chrome DevTools Snippet)
 * ----------------------------------------------------------------------------
 * Reads what an animation ACTUALLY does by sampling computed style over time,
 * regardless of how it is driven (CSS transition/keyframes, GSAP rAF inline
 * transforms, CSS sprite steps()). The DevTools "Animations" panel only sees
 * CSS/WAAPI; this sees everything because it reads the rendered result.
 *
 * USAGE (paste into Sources > Snippets, hit Run once, then drive from Console):
 *
 *   __cap.libs()                         // which animation libs are loaded
 *   __cap.map()                          // static structural map (phase 1): GSAP/
 *                                        //   ScrollTrigger registry + CSS loops +
 *                                        //   hover candidates + split/reveal hosts
 *   __cap.on('.selector')                // arm on hover (default trigger)
 *   __cap.on('.selector', {trigger:'scroll'})   // arm on scroll-into-view
 *   __cap.scan('.section')               // diff-scan: find what moves in a region
 *                                        //   (for layers you cannot click —
 *                                        //    pointer-events:none, behind text)
 *   // ...now hover / scroll the thing...
 *   __cap.dump()                         // finalize -> copies .animation.json
 *
 * Triggers: 'hover' (default) | 'scroll' | 'load' | 'manual'
 * Output: a SPEC (not code) — { summary, findings[] } with per-layer measured
 *         timing/easing + frame timeline. Pure JSON to clipboard + window.__capLast.
 *         Hand it to an LLM to write the recreation in your stack.
 * ========================================================================== */
(() => {
  const PROPS = ['transform', 'opacity', 'filter', 'clipPath',
                 'backgroundPosition', 'backgroundColor', 'color', 'height', 'width'];
  const LEAD_PROPS = ['transform', 'opacity', 'filter', 'clipPath',
                      'backgroundPosition', 'height', 'width', 'backgroundColor', 'color'];
  const INTERACTIVE_SELECTOR = 'a, button, [role="button"], [onclick], [tabindex]:not([tabindex="-1"])';
  const VISUAL_LAYER_SELECTOR = [
    'img', 'video', 'picture', 'canvas', 'svg',
    '[class*="cover"]', '[class*="media"]', '[class*="image"]',
    '[class*="img"]', '[class*="overlay"]', '[class*="deco"]',
    '[class*="mask"]', '[class*="clip"]', '[class*="arrow"]'
  ].join(', ');
  const USEFUL_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-id',
                        'data-name', 'data-w-id', 'aria-label', 'role'];
  const SETTLE_MS = 220;     // stop after this much no-change (once something moved)
  const MAX_MS = 6000;       // hard cap
  const SCAN_THROTTLE_MS = 30;

  const r1 = n => Math.round(n * 10) / 10;
  const r2 = n => Math.round(n * 100) / 100;
  const r3 = n => Math.round(n * 1000) / 1000;
  const now = () => performance.now();
  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const cssEscape = v => (window.CSS && CSS.escape)
    ? CSS.escape(String(v))
    : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const attrEscape = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  /* ---- library detection ------------------------------------------------ */
  function detectLibs() {
    return Object.entries({
      GSAP: !!window.gsap,
      ScrollTrigger: !!(window.ScrollTrigger || (window.gsap && window.gsap.ScrollTrigger)),
      Lenis: !!(window.Lenis || window.lenis),
      'Three.js': !!window.THREE,
      Motion: !!window.Motion,
      'Framer Motion': !!document.querySelector('[data-projection-id],[data-framer-name]'),
      Webflow: !!window.Webflow,
      jQuery: !!window.jQuery,
      Lottie: !!(window.lottie || window.bodymovin),
      anime: !!window.anime,
    }).filter(([, v]) => v).map(([k]) => k);
  }

  /* ---- transform matrix -> readable parts ------------------------------- */
  function decodeTransform(str) {
    if (!str || str === 'none') return { kind: 'none' };
    const m = str.match(/matrix(3d)?\(([^)]+)\)/);
    if (!m) return { raw: str };
    const v = m[2].split(',').map(parseFloat);
    if (!m[1]) {
      const [a, b, c, d, e, f] = v;
      return {
        scaleX: r3(Math.hypot(a, b)), scaleY: r3(Math.hypot(c, d)),
        rotate: r1(Math.atan2(b, a) * 180 / Math.PI),
        x: r2(e), y: r2(f),
      };
    }
    const sx = Math.hypot(v[0], v[1], v[2]) || 1;
    const sy = Math.hypot(v[4], v[5], v[6]) || 1;
    const sz = Math.hypot(v[8], v[9], v[10]) || 1;
    const R = [
      [v[0] / sx, v[4] / sy, v[8] / sz],
      [v[1] / sx, v[5] / sy, v[9] / sz],
      [v[2] / sx, v[6] / sy, v[10] / sz],
    ];
    const ry = Math.asin(Math.max(-1, Math.min(1, -R[2][0])));
    let rx, rz;
    if (Math.abs(R[2][0]) < 0.9999) { rx = Math.atan2(R[2][1], R[2][2]); rz = Math.atan2(R[1][0], R[0][0]); }
    else { rx = Math.atan2(-R[1][2], R[1][1]); rz = 0; }
    const deg = rad => r1(rad * 180 / Math.PI);
    return {
      scaleX: r3(sx), scaleY: r3(sy), scaleZ: r3(sz),
      rotateX: deg(rx), rotateY: deg(ry), rotateZ: deg(rz),
      x: r2(v[12]), y: r2(v[13]), z: r2(v[14]), _approx3d: true,
    };
  }

  /* ---- element / target resolution -------------------------------------- */
  function queryAllSafe(selector) {
    try { return [...document.querySelectorAll(selector)]; }
    catch (e) { console.warn('[capture] invalid selector', selector, e.message); return []; }
  }

  function isRendered(el) {
    if (!el || el.nodeType !== 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function resolve(t) {
    if (typeof t !== 'string') return t;
    const matches = queryAllSafe(t);
    return matches.find(isRendered) || matches[0] || null;
  }

  // A target is a "stagger group" if it has several similar leaf-ish children
  // (e.g. split text: many .stagger-char divs). Returns child elements or null.
  function staggerChildren(el) {
    const kids = [...el.children];
    if (kids.length < 3) return null;
    const sameTag = kids.every(k => k.tagName === kids[0].tagName);
    const cls = kids[0].classList[0];
    const sameClass = cls && kids.every(k => k.classList.contains(cls));
    const leafish = kids.every(k => k.children.length <= 1);
    return (sameTag && sameClass && leafish) ? kids : null;
  }

  // Split a CSS list on TOP-LEVEL commas only, so cubic-bezier(0.3, 0.7, ...)
  // stays intact instead of being shredded by a naive split(',').
  function splitTop(str) {
    const out = []; let depth = 0, cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  /* ---- authoritative easing/duration for CSS transitions ---------------- */
  function cssTiming(el, prop) {
    const cs = getComputedStyle(el);
    const props = splitTop(cs.transitionProperty);
    const idx = props.findIndex(p => p === prop || p === 'all');
    if (idx === -1) return null;
    const durs = splitTop(cs.transitionDuration);
    const tims = splitTop(cs.transitionTimingFunction);
    const pick = (a, i) => a[i % a.length];
    const dur = pick(durs, idx);
    if (dur === '0s') return null;
    return { duration: dur, easing: pick(tims, idx) };
  }

  /* ====================================================================== */
  const S = { armed: false, mode: null, t0: 0, raf: 0, tracks: [], cleanup: [],
              started: false, lastChange: 0, root: null, candidates: null,
              baseline: null, lastScan: 0, trigger: null, terminationReason: null,
              finishedAt: 0, captureSource: null };

  function readVals(el) {
    const cs = getComputedStyle(el);
    const o = {};
    for (const p of PROPS) o[p] = cs[p];
    return o;
  }

  function track(el) {
    const locator = locatorFor(el);
    const t = { el, sel: locator.shortSelector, locator, frames: [] };
    S.tracks.push(t);
    return t;
  }

  function pushFrame(t, vals) {
    const last = t.frames[t.frames.length - 1];
    if (!last || PROPS.some(p => last.vals[p] !== vals[p])) {
      t.frames.push({ t: r1(now() - S.t0), vals });
      S.lastChange = now();
    }
  }

  function loopSingle() {
    for (const t of S.tracks) pushFrame(t, readVals(t.el));
    const elapsed = now() - S.t0;
    const settled = S.lastChange && (now() - S.lastChange > SETTLE_MS) &&
                    S.tracks.some(t => t.frames.length > 1);
    if (elapsed > MAX_MS) return finish('maxDuration');
    if (settled) return finish('settled');
    S.raf = requestAnimationFrame(loopSingle);
  }

  function loopScan() {
    const tnow = now();
    if (tnow - S.lastScan >= SCAN_THROTTLE_MS) {
      S.lastScan = tnow;
      for (let i = 0; i < S.candidates.length; i++) {
        const el = S.candidates[i];
        const vals = readVals(el);
        const base = S.baseline[i];
        if (PROPS.some(p => base[p] !== vals[p])) {
          let t = S.tracks.find(x => x.el === el);
          if (!t) { t = track(el); t.frames.push({ t: 0, vals: base }); }
          pushFrame(t, vals);
        }
      }
    }
    const elapsed = tnow - S.t0;
    const settled = S.lastChange && (tnow - S.lastChange > SETTLE_MS) && S.tracks.length;
    if (elapsed > MAX_MS) return finish('maxDuration');
    if (settled) return finish('settled');
    S.raf = requestAnimationFrame(loopScan);
  }

  function start() {
    if (S.started) return;
    S.started = true; S.t0 = now(); S.lastChange = 0; S.lastScan = 0;
    S.terminationReason = null; S.finishedAt = 0;
    if (S.mode === 'scan') {
      S.baseline = S.candidates.map(readVals);
      S.raf = requestAnimationFrame(loopScan);
    } else {
      // snapshot the true rest state as frame 0, before the trigger moves it
      for (const t of S.tracks) t.frames.push({ t: 0, vals: readVals(t.el) });
      S.raf = requestAnimationFrame(loopSingle);
    }
    console.log('%c[capture] recording…', 'color:#fa0', 'interact now, then run __cap.dump()');
  }

  function arm(trigger, triggerEl) {
    S.armed = true; S.started = false;
    S.trigger = trigger; S.root = S.root || triggerEl;
    if (trigger === 'manual' || trigger === 'load') { start(); return; }
    if (trigger === 'scroll') {
      const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) start(); },
                                          { threshold: 0.25 });
      io.observe(triggerEl); S.cleanup.push(() => io.disconnect());
      console.log('%c[capture] armed (scroll)', 'color:#0af', 'scroll the element into view');
    } else { // hover
      const h = () => start();
      triggerEl.addEventListener('mouseenter', h, { once: true });
      S.cleanup.push(() => triggerEl.removeEventListener('mouseenter', h));
      console.log('%c[capture] armed (hover)', 'color:#0af', 'hover the element');
    }
  }

  function finish(reason = 'manualDump') {
    cancelAnimationFrame(S.raf); S.raf = 0;
    S.finishedAt = now();
    S.terminationReason = S.terminationReason || reason;
    const moved = S.tracks.filter(t => t.frames.length > 1);
    console.log(`%c[capture] done — ${moved.length} element(s) moved. Run __cap.dump()`,
                'color:#0c0');
  }

  /* ---- analysis: turn a track's frames into a finding ------------------- */
  function measuredTiming(frames) {
    return { duration: `${r2(frames[frames.length - 1].t / 1000)}s (measured)`,
             easing: 'unknown (rAF/JS) — verify' };
  }

  function changedProperties(frames) {
    if (!frames.length) return [];
    return PROPS.filter(p => frames.some(fr => fr.vals[p] !== frames[0].vals[p]));
  }

  function rawTimeline(frames, map, includeRaw) {
    return includeRaw ? frames.map(fr => ({ t: fr.t, v: map(fr) })) : [];
  }

  function propertyAnalysis(t, prop, includeRaw) {
    const f = t.frames;
    const cs = getComputedStyle(t.el);
    if (prop === 'transform') {
      const a = decodeTransform(f[0].vals.transform);
      const b = decodeTransform(f[f.length - 1].vals.transform);
      return {
        from: a,
        to: b,
        timing: cssTiming(t.el, 'transform') || measuredTiming(f),
        technique: describeTransform(a, b),
        timeline: downsample(f, fr => decodeTransform(fr.vals.transform)),
        rawFrames: rawTimeline(f, fr => decodeTransform(fr.vals.transform), includeRaw),
      };
    }

    if (prop === 'backgroundPosition' && (/steps/.test(cs.animationTimingFunction) ||
        /sprite/i.test(t.el.className))) {
      const positions = [...new Set(f.map(fr => fr.vals.backgroundPosition))];
      const animation = { name: cs.animationName, duration: cs.animationDuration,
                          timing: cs.animationTimingFunction, iteration: cs.animationIterationCount };
      return {
        type: 'css-sprite',
        from: f[0].vals.backgroundPosition,
        to: f[f.length - 1].vals.backgroundPosition,
        timing: animation,
        technique: `CSS sprite-sheet: ${positions.length} frames stepped via background-position`,
        timeline: downsample(f, fr => fr.vals.backgroundPosition),
        rawFrames: rawTimeline(f, fr => fr.vals.backgroundPosition, includeRaw),
        spriteSheet: cs.backgroundImage.replace(/^url\(["']?|["']?\)$/g, ''),
        backgroundSize: cs.backgroundSize,
        animation,
        fps: r1(positions.length / (parseFloat(cs.animationDuration) || 1)),
        framePositions: positions,
      };
    }

    return {
      from: f[0].vals[prop],
      to: f[f.length - 1].vals[prop],
      timing: cssTiming(t.el, prop) || measuredTiming(f),
      technique: `${prop}: ${f[0].vals[prop]} -> ${f[f.length - 1].vals[prop]}`,
      timeline: downsample(f, fr => fr.vals[prop]),
      rawFrames: rawTimeline(f, fr => fr.vals[prop], includeRaw),
    };
  }

  function analyze(t, opts = {}) {
    const f = t.frames;
    const changed = changedProperties(f);
    const out = {
      selector: t.sel,
      locator: t.locator || locatorFor(t.el),
      frameCount: f.length,
    };
    if (!changed.length) { out.type = 'none'; return out; }

    const properties = {};
    for (const prop of changed) properties[prop] = propertyAnalysis(t, prop, opts.raw !== false);
    const leadProperty = LEAD_PROPS.find(p => properties[p]) || changed[0];
    const lead = properties[leadProperty];
    Object.assign(out, {
      leadProperty,
      properties,
      type: lead.type || leadProperty,
      from: lead.from,
      to: lead.to,
      timing: lead.timing,
      technique: lead.technique,
      timeline: lead.timeline,
    });
    for (const key of ['spriteSheet', 'backgroundSize', 'animation', 'fps', 'framePositions']) {
      if (lead[key] !== undefined) out[key] = lead[key];
    }
    return out;
  }

  function describeTransform(a, b) {
    const bits = [];
    if (a.scaleX !== undefined && b.scaleX !== undefined && Math.abs(a.scaleX - b.scaleX) > 0.01)
      bits.push(`scale ${a.scaleX}->${b.scaleX}`);
    if ((a.y || 0) !== (b.y || 0)) bits.push(`y ${a.y || 0}->${b.y || 0}px`);
    if ((a.x || 0) !== (b.x || 0)) bits.push(`x ${a.x || 0}->${b.x || 0}px`);
    ['rotate', 'rotateX', 'rotateY', 'rotateZ'].forEach(k => {
      if (a[k] !== undefined && Math.abs((a[k] || 0) - (b[k] || 0)) > 0.5)
        bits.push(`${k} ${a[k] || 0}->${b[k] || 0}deg`);
    });
    return bits.length ? bits.join(', ') : 'transform change';
  }

  function downsample(frames, map, n = 12) {
    if (frames.length <= n) return frames.map(fr => ({ t: fr.t, v: map(fr) }));
    const step = (frames.length - 1) / (n - 1), out = [];
    for (let i = 0; i < n; i++) { const fr = frames[Math.round(i * step)]; out.push({ t: fr.t, v: map(fr) }); }
    return out;
  }

  /* ---- stagger detection across multiple tracks ------------------------- */
  function staggerSummary(findings) {
    const tf = findings.filter(x => x.type === 'transform');
    if (tf.length < 3) return null;
    const motionMagnitude = (v, base) => {
      const y = Math.abs((v.y || 0) - (base.y || 0));
      const x = Math.abs((v.x || 0) - (base.x || 0));
      const sc = Math.abs((v.scaleX ?? 1) - (base.scaleX ?? 1)) * 100;
      return Math.max(y, x, sc);
    };
    const motionStart = samples => {
      if (!samples || samples.length < 2) return 0;
      const base = samples[0].v || {};
      const hit = samples.find(s => s.t > 0 && motionMagnitude(s.v || {}, base) > 0.5);
      return hit ? hit.t : 0;
    };
    const peakTime = samples => {
      let max = 0, tp = 0;
      const base = (samples[0] && samples[0].v) || {};
      samples.forEach(s => {
        const mag = motionMagnitude(s.v || {}, base);
        if (mag > max) { max = mag; tp = s.t; }
      });
      return tp;
    };
    // Prefer first movement time so reveal-style staggers are not all t=0.
    const peaks = tf.map((x, i) => {
      const samples = (x.properties && x.properties.transform && x.properties.transform.rawFrames && x.properties.transform.rawFrames.length)
        ? x.properties.transform.rawFrames
        : (x.timeline || []);
      const tStart = motionStart(samples);
      return { i, tPeak: tStart || peakTime(samples) };
    }).sort((a, b) => a.tPeak - b.tPeak);
    const deltas = [];
    for (let i = 1; i < peaks.length; i++) deltas.push(peaks[i].tPeak - peaks[i - 1].tPeak);
    const stagger = deltas.length ? r1(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
    return { items: tf.length, staggerMs: stagger,
             order: peaks.map(p => p.i) };
  }

  /* ---- whole-animation plain-English summary ---------------------------- */
  // The spec is the product; an LLM writes the recreation from it. This sentence
  // describes the ENTIRE captured animation (all layers), not just the first.
  function summarize(findings, stagger) {
    if (!findings.length) return 'no animation captured';
    if (findings.length === 1 && findings[0].type === 'css-sprite') {
      const f = findings[0];
      return `CSS sprite-sheet: ${f.framePositions.length} frames at ~${f.fps}fps, looping (${f.animation.duration} ${f.animation.timing}).`;
    }
    if (stagger) {
      const f = findings[0], t = f.timing || {};
      return `Staggered ${stagger.items}-item animation (e.g. split text): each item ${f.technique}, ~${stagger.staggerMs}ms apart, ${t.duration || '?'} ${t.easing || ''}.`.trim();
    }
    const t = findings[0].timing || {};
    const parts = findings.map(f => {
      const props = Object.keys(f.properties || {});
      const suffix = props.length > 1 ? ` + ${props.filter(p => p !== f.leadProperty).join(', ')}` : '';
      return `${f.selector} [${f.technique}${suffix}]`;
    });
    const lead = findings.length === 1 ? 'One element animates' : `${findings.length} layers animate together`;
    return `${lead}: ${parts.join('; ')} — ${t.duration || '?'} ${t.easing || ''}.`.trim();
  }

  /* ---- short CSS path for an element ------------------------------------ */
  function cssPath(el) {
    if (!el || !el.tagName) return null;          // null trigger / document / text node
    if (el.id) return '#' + cssEscape(el.id);
    const cls = usefulClasses(el).slice(0, 2).map(c => '.' + cssEscape(c)).join('');
    return el.tagName.toLowerCase() + cls;
  }

  function usefulClasses(el) {
    return [...(el.classList || [])]
      .filter(c => c && c.length < 80 && !/^(is-|has-|js-|w--|_|--)/.test(c));
  }

  function nthOfType(el) {
    let n = 1, p = el;
    while ((p = p.previousElementSibling)) if (p.tagName === el.tagName) n++;
    return n;
  }

  function safeMatches(el, selector) {
    try { return el.matches(selector); }
    catch (e) { return false; }
  }

  function selectorSegments(el, withNth = false) {
    if (!el || !el.tagName) return [];
    const tag = el.tagName.toLowerCase();
    const out = [];
    if (el.id) {
      out.push('#' + cssEscape(el.id), tag + '#' + cssEscape(el.id));
    }
    for (const attr of USEFUL_ATTRS) {
      const value = el.getAttribute(attr);
      if (value && value.length < 100) {
        out.push(`${tag}[${attr}="${attrEscape(value)}"]`);
        out.push(`[${attr}="${attrEscape(value)}"]`);
      }
    }
    const cls = usefulClasses(el).slice(0, 3);
    if (cls.length) {
      out.push(tag + cls.map(c => '.' + cssEscape(c)).join(''));
      out.push(tag + '.' + cssEscape(cls[0]));
    }
    out.push(tag);
    const base = uniq(out);
    if (!withNth) return base;
    const nth = `:nth-of-type(${nthOfType(el)})`;
    return uniq([...base.map(s => s + nth), tag + nth]);
  }

  function isUniqueFor(selector, el) {
    const matches = queryAllSafe(selector);
    return matches.length === 1 && matches[0] === el;
  }

  function siblingCountForSegment(el, segment) {
    if (!el.parentElement) return 1;
    return [...el.parentElement.children].filter(sib => safeMatches(sib, segment)).length;
  }

  function segmentForPath(el) {
    const plain = selectorSegments(el, false);
    const stable = plain.find(s => s.includes('#') || s.includes('[') || s.includes('.')) || plain[0];
    if (!stable) return null;
    if (siblingCountForSegment(el, stable) > 1 && !stable.includes('#')) {
      return stable + `:nth-of-type(${nthOfType(el)})`;
    }
    return stable;
  }

  function uniqueSelector(el) {
    if (!el || !el.tagName) return null;
    for (const seg of selectorSegments(el, false)) if (isUniqueFor(seg, el)) return seg;

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document) {
      for (const seg of [...selectorSegments(node, false), ...selectorSegments(node, true)]) {
        const selector = [seg, ...parts].join(' > ');
        if (isUniqueFor(selector, el)) return selector;
      }
      const pathSeg = segmentForPath(node);
      if (!pathSeg) break;
      parts.unshift(pathSeg);
      node = node.parentElement;
    }
    return parts.join(' > ') || cssPath(el);
  }

  function conciseText(el) {
    if (!el) return null;
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > 90 ? text.slice(0, 87) + '...' : text;
  }

  function locatorFor(el) {
    const shortSelector = cssPath(el);
    const matches = shortSelector ? queryAllSafe(shortSelector) : [];
    return {
      shortSelector,
      uniqueSelector: uniqueSelector(el),
      matchCount: matches.length,
      visibleMatchCount: matches.filter(isRendered).length,
      text: conciseText(el),
    };
  }

  /* ---- public API ------------------------------------------------------- */
  function reset() {
    cancelAnimationFrame(S.raf);
    S.cleanup.forEach(fn => fn()); S.cleanup = [];
    Object.assign(S, { armed: false, mode: null, t0: 0, raf: 0, tracks: [],
      started: false, lastChange: 0, root: null, candidates: null, baseline: null,
      lastScan: 0, trigger: null, terminationReason: null, finishedAt: 0,
      captureSource: null });
  }

  function captureDuration() {
    if (!S.started || !S.t0) return 0;
    return r1((S.finishedAt || now()) - S.t0);
  }

  const api = {
    libs: () => { const l = detectLibs(); console.log('%c[capture] libs:', 'color:#0af', l.join(', ') || '(none)'); return l; },

    // Static structural MAP (no interaction). Reads what can be known without
    // capturing motion: the GSAP/ScrollTrigger registry (often the full spec for
    // scroll animations), CSS transition/loop declarations, and the candidate
    // lists capture must drive (hovers it can't see, reveals it must trigger).
    // Run this headless in phase 1; feed it into the capture plan.
    map() {
      const easeName = e => !e ? null : (typeof e === 'string' ? e : (e.name || (e.vars && e.vars.name) || 'fn'));
      const SKIP = ['ease','duration','delay','stagger','scrollTrigger','onComplete','onStart',
        'onUpdate','immediateRender','overwrite','data','paused','repeat','yoyo','id','inherit',
        'keyframes','startAt','runBackwards','parent','callbackScope','onCompleteParams'];
      const tweenInfo = t => {
        const v = t.vars || {};
        const props = Object.keys(v).filter(k => !SKIP.includes(k));
        return { targets: (t.targets ? t.targets() : []).slice(0, 4).map(cssPath),
          targetCount: t.targets ? t.targets().length : 0,
          duration: t.duration ? t.duration() : v.duration, ease: easeName(v.ease),
          stagger: v.stagger || null,
          props: props.reduce((o, k) => { o[k] = typeof v[k] === 'object' ? '(obj)' : v[k]; return o; }, {}) };
      };
      const out = { libs: detectLibs(), scrollTriggers: [], hoverCandidates: [],
        cssHovers: [], loops: [], splitReveals: [], sections: [] };

      out.sections = [...document.querySelectorAll('section, main > *')]
        .map(cssPath).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 40);

      try {
        const ST = window.ScrollTrigger;
        if (ST && ST.getAll) out.scrollTriggers = ST.getAll().map((s, i) => {
          const a = s.animation, anims = [];
          if (a) { if (a.getChildren) a.getChildren(false, true, true).forEach(c => anims.push(tweenInfo(c)));
                   else anims.push(tweenInfo(a)); }
          return { i, trigger: cssPath(s.trigger), start: s.vars.start, end: s.vars.end,
            scrub: s.vars.scrub ?? false, pin: !!s.vars.pin, toggleActions: s.vars.toggleActions || null,
            callbacks: Object.keys(s.vars).filter(k => /^on/.test(k)), anims };
        });
      } catch (e) { out.scrollTriggers = 'err: ' + e.message; }

      // Interactive elements capture must brute-force-hover (event-bound GSAP
      // hovers are invisible to the registry AND to the CSS sweep).
      const seenH = new Set();
      for (const el of document.querySelectorAll(
        'a, button, [role="button"], [class*="btn"], [class*="link"], [class*="cta"], [class*="arrow"], [onclick]')) {
        const s = cssPath(el);
        if (!seenH.has(s)) { seenH.add(s); if (out.hoverCandidates.length < 80) out.hoverCandidates.push(s); }
      }

      // CSS-transition hovers (the part the sweep CAN read directly).
      const seenC = new Set();
      for (const el of document.querySelectorAll(
        'a, button, [class*="card"], [class*="item"], [class*="btn"], [class*="link"], [class*="cover"], [class*="accordion"]')) {
        const cs = getComputedStyle(el);
        if (/transform|opacity|filter|height|all/.test(cs.transitionProperty) && parseFloat(cs.transitionDuration) > 0) {
          const k = cssPath(el) + cs.transitionDuration;
          if (!seenC.has(k)) { seenC.add(k);
            if (out.cssHovers.length < 40) out.cssHovers.push({ sel: cssPath(el),
              prop: cs.transitionProperty, dur: cs.transitionDuration, ease: cs.transitionTimingFunction }); }
        }
      }

      // Infinite CSS animations (sprite sheets, marquees).
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.animationName !== 'none' && cs.animationIterationCount === 'infinite' && out.loops.length < 40)
          out.loops.push({ sel: cssPath(el), name: cs.animationName, dur: cs.animationDuration, timing: cs.animationTimingFunction });
      }

      // SplitText / mask reveal hosts — usually LOAD or scroll reveals the
      // registry doesn't expose. Grouped by heading host so they read as one
      // animation, not N spans.
      const groups = {};
      for (const el of document.querySelectorAll('[class*="split"], [class*="lines-"], .word, .char, [class*="stagger"]')) {
        const host = el.closest('h1,h2,h3,h4,p,[class*="heading"],[class*="title"]') || el.parentElement;
        const hs = cssPath(host);
        if (!groups[hs]) groups[hs] = { host: hs, section: cssPath(host && host.closest('section')), count: 0, kinds: new Set() };
        groups[hs].count++; groups[hs].kinds.add((el.className.toString().split(' ')[0]) || el.tagName.toLowerCase());
      }
      out.splitReveals = Object.values(groups).map(g => ({ host: g.host, section: g.section, count: g.count, kinds: [...g.kinds] })).slice(0, 20);

      window.__capMap = out;
      console.log('%c[capture] map', 'color:#0af', `${out.scrollTriggers.length||0} ST · ${out.hoverCandidates.length} hover cands · ${out.splitReveals.length} reveal hosts`);
      return out;
    },

    on(target, opts = {}) {
      reset();
      const el = resolve(target);
      if (!el) { console.warn('[capture] no element for', target); return; }
      S.mode = 'single'; S.root = el; S.captureSource = opts.captureSource || null;
      const kids = staggerChildren(el);
      (kids || [el]).forEach(track);
      console.log(`[capture] tracking ${kids ? kids.length + ' child items (stagger)' : '1 element'}`);
      arm(opts.trigger || 'hover', el);
      return this;
    },
    scan(target, opts = {}) {
      reset();
      const root = resolve(target) || document.body;
      S.mode = 'scan'; S.root = root; S.captureSource = opts.captureSource || null;
      S.candidates = [root, ...root.querySelectorAll('*')].slice(0, 4000);
      if (S.candidates.length === 4000) console.warn('[capture] scan capped at 4000 elements — pass a tighter root');
      console.log(`[capture] scanning ${S.candidates.length} elements under`, cssPath(root));
      arm(opts.trigger || 'hover', root);
      return this;
    },
    dump(opts = {}) {
      if (S.raf) finish('manualDump');
      else if (!S.terminationReason) {
        S.terminationReason = S.started ? 'manualDump' : 'stopped';
        if (S.started && !S.finishedAt) S.finishedAt = now();
      }
      const moved = S.tracks.filter(t => t.frames.length > 1);
      const findings = moved.map(t => analyze(t, opts)).filter(x => x.type !== 'none');
      const stagger = staggerSummary(findings);
      const rootLocator = S.root ? locatorFor(S.root) : null;
      const report = {
        meta: {
          source: location.href,
          capturedFrom: 'capture-animation.js',
          libraries: detectLibs(),
          mode: S.mode,
          trigger: S.trigger,
          captureSource: opts.captureSource || S.captureSource || undefined,
          terminationReason: S.terminationReason,
          sampledProperties: [...PROPS],
          rootSelector: rootLocator && (rootLocator.uniqueSelector || rootLocator.shortSelector),
          rootLocator,
          durationMs: captureDuration(),
          elementsMoved: findings.length,
        },
        summary: summarize(findings, stagger),
        stagger,
        findings,
      };
      const json = JSON.stringify(report, null, 2);
      // Pure spec JSON to the clipboard — an LLM (or you) writes the code from it.
      const copied = (() => {
        try { navigator.clipboard.writeText(json); return 'clipboard'; } catch (e) {}
        try { if (typeof copy === 'function') { copy(report); return 'clipboard (copy())'; } } catch (e) {}
        return 'console only';
      })();
      window.__capLast = report;            // re-readable by an agent via MCP
      console.log(`%c[capture] ${report.summary}`, 'color:#0c0;font-weight:bold');
      console.log(`%c[capture] ${findings.length} finding(s) -> ${copied} · also at window.__capLast`, 'color:#0a0');
      console.log(json);
      return report;
    },
    stop() {
      if (S.raf) finish('stopped');
      reset();
    },
  };

  /* ---- interactive element picker (toolbar-button driven) --------------- */
  // Click the toolbar button -> picker ON. Hover an element so its animation
  // plays, then click it: we capture that element's subtree and dump (console
  // + clipboard). Esc cancels. The hover-then-click gesture naturally triggers
  // hover animations while you aim.
  const picker = (() => {
    let active = false, target = null, box, label, bar, statusTimer = 0, targetName = '';

    function pickRoot(el) {
      const interactive = el.closest(INTERACTIVE_SELECTOR);
      const visual = el.closest(VISUAL_LAYER_SELECTOR);
      if (interactive) {
        if (visual && interactive.contains(visual)) return visual;
        return interactive;
      }
      return visual || el;
    }

    function movedLayerCount() {
      return S.tracks.filter(t => t.frames.length > 1).length;
    }

    function setStatus(text) {
      if (bar) bar.textContent = text;
    }

    function refreshStatus() {
      if (!active) return;
      if (!target) {
        setStatus('hover an element, then click to capture · Esc cancels');
        return;
      }
      const state = S.raf ? 'recording' : (S.started ? 'settled' : 'selected');
      setStatus(`${state}: ${targetName} · ${movedLayerCount()} moved · click to finish`);
    }

    function startStatusTimer() {
      clearInterval(statusTimer);
      statusTimer = setInterval(refreshStatus, 120);
    }

    function waitForRecorder(timeoutMs = 1200) {
      const t0 = now();
      return new Promise(resolve => {
        const tick = () => {
          if (!S.raf || now() - t0 >= timeoutMs) resolve();
          else requestAnimationFrame(tick);
        };
        tick();
      });
    }

    function ensureUI() {
      if (box) return;
      const base = { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none' };
      box = document.createElement('div');
      Object.assign(box.style, base, { background: 'rgba(25,160,255,.22)',
        border: '1px solid #19a0ff', boxShadow: '0 0 0 1px rgba(255,255,255,.6)',
        borderRadius: '2px', display: 'none' });
      label = document.createElement('div');
      Object.assign(label.style, base, { font: '11px/1.4 monospace', background: '#19a0ff',
        color: '#fff', padding: '1px 5px', borderRadius: '3px', display: 'none', whiteSpace: 'nowrap' });
      bar = document.createElement('div');
      Object.assign(bar.style, base, { left: '50%', top: '12px', transform: 'translateX(-50%)',
        font: '12px/1.4 system-ui,sans-serif', background: '#16181d', color: '#fff',
        padding: '6px 12px', borderRadius: '6px', boxShadow: '0 2px 12px rgba(0,0,0,.45)' });
      bar.textContent = 'hover an element, then click to capture · Esc cancels';
      document.documentElement.append(box, label, bar);
    }
    function highlight(root) {
      const r = root.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px' });
      label.style.display = 'block';
      label.textContent = cssPath(root);
      label.style.left = r.left + 'px';
      label.style.top = Math.max(0, r.top - 20) + 'px';
    }
    function onMove(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === label || el === bar) return;
      const root = pickRoot(el);
      highlight(root);
      if (root !== target) {
        target = root;
        targetName = cssPath(root) || 'element';
        api.scan(target, { trigger: 'manual', captureSource: 'picker' });
        refreshStatus();
      }
    }
    const swallow = e => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    async function onClick(e) {
      swallow(e);
      const picked = target;
      if (!picked) { disable(); return; }
      document.removeEventListener('mousemove', onMove, true);
      setStatus(`finishing: ${targetName} · ${movedLayerCount()} moved`);
      await waitForRecorder();
      console.log('%c[capture] picked ' + cssPath(picked), 'color:#19a0ff;font-weight:bold');
      api.dump({ captureSource: 'picker' });
      disable();
    }
    function onKey(e) {
      if (e.key === 'Escape') { swallow(e); api.stop(); disable(); console.log('[capture] picker cancelled'); }
    }
    function enable() {
      if (active) return; active = true; ensureUI();
      box.style.display = 'none'; label.style.display = 'none'; bar.style.display = 'block';
      target = null; targetName = ''; refreshStatus(); startStatusTimer();
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('mousedown', swallow, true);
      document.addEventListener('mouseup', swallow, true);
      document.addEventListener('keydown', onKey, true);
      console.log('%c[capture] picker ON — aim and click', 'color:#19a0ff;font-weight:bold');
    }
    function disable() {
      if (!active) return; active = false; target = null;
      clearInterval(statusTimer); statusTimer = 0;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('mouseup', swallow, true);
      document.removeEventListener('keydown', onKey, true);
      if (box) { box.style.display = 'none'; label.style.display = 'none'; bar.style.display = 'none'; }
    }
    return { enable, disable, toggle() { active ? disable() : enable(); } };
  })();
  api.pick = () => picker.enable();

  window.__cap = api;
  window.__capPicker = picker;
  console.log('%c[capture] ready', 'color:#0c0;font-weight:bold',
    '— __cap.map() (phase 1) · __cap.on/scan + dump (phase 2) · __cap.libs() · __cap.pick()');
})();
