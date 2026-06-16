#!/usr/bin/env bun
/* Unit tests for the assembler's spec-shaping helpers in bin/yoinkit:
 *
 *  (a) vendor de-rank  — third-party/injected animations (Shop Pay, Intercom,
 *      consent banners, chat widgets) are tagged and kept OUT of the signature
 *      tier, in the spec, with their source labeled.
 *  (b) drawSVG grouping — near-identical tweens on one ScrollTrigger collapse to
 *      a single counted entry instead of one row per path.
 *  (c) action label    — the preflight/failure label reflects the real action
 *      (hover/click), so a hover failure isn't reported as "scroll target".
 *
 * These are pure functions, so we require the CLI directly (its entrypoint is
 * guarded by require.main === module) and call them with hand-built map data. */
'use strict';

const { expect, test } = require('bun:test');
const path = require('path');

const {
  actionLabel,
  scrollTriggerAnimations,
  vendorAnimationMatch,
  tagVendorAnimations,
  renderAnimationsMarkdown,
} = require(path.join(__dirname, '..', 'bin', 'yoinkit'));

/* ---------- (c) action label ---------- */

test('actionLabel: hover action and type both report "hover"', () => {
  expect(actionLabel('hover .work-card', 'hover', 'scroll target')).toBe('hover');
  expect(actionLabel(null, 'hover', 'scroll target')).toBe('hover');
});

test('actionLabel: click action reports "click"', () => {
  expect(actionLabel('click button.cta', 'click', 'scroll target')).toBe('click');
});

test('actionLabel: array/object actions resolve their verb', () => {
  expect(actionLabel(['wait 100', 'hover .x'], 'manual', 'scroll target')).toBe('hover');
  expect(actionLabel([{ command: 'click', selector: '.x' }], 'manual', 'scroll target')).toBe('click');
});

test('actionLabel: non-pointer captures fall back to the supplied label', () => {
  // A real scroll target (explicit scrollTarget, no pointer action) keeps the
  // generic label rather than borrowing an unrelated verb.
  expect(actionLabel(null, 'manual', 'scroll target')).toBe('scroll target');
  expect(actionLabel('scrollintoview .section', 'scroll', 'scroll target')).toBe('scroll target');
  expect(actionLabel('', undefined, 'target')).toBe('target');
});

/* ---------- (b) drawSVG grouping ---------- */

function drawSvgTrigger(i, count, duration) {
  return {
    i,
    trigger: 'div.stacked-cards__collection',
    start: 'top center',
    end: 'bottom center',
    scrub: 0,
    anims: Array.from({ length: count }, () => ({
      targets: ['path', 'path'],
      targetCount: 2,
      duration,
      ease: 'Power1.easeOut',
      props: { drawSVG: '0% 100%' },
    })),
  };
}

test('grouping: near-identical drawSVG tweens collapse to one counted entry', () => {
  const animations = scrollTriggerAnimations({ scrollTriggers: [drawSvgTrigger(3, 4, 0.75)] }, []);
  expect(animations).toHaveLength(1);
  const [entry] = animations;
  expect(entry.count).toBe(4);
  expect(entry.layers).toBe(8);
  expect(entry.label).toMatch(/scroll motion \(×4\)/);
  expect(entry.notes).toMatch(/4 near-identical registry tweens grouped/);
  // Stable id: keyed off the first anim in the group, so single-tween output is
  // byte-identical to the pre-grouping behavior.
  expect(entry.id).toBe('scrolltrigger-3-0-path');
});

test('grouping: distinct targets/durations stay separate', () => {
  const st = {
    i: 2,
    trigger: 'div.about__tile',
    scrub: 0,
    anims: [
      { targets: ['div.rotate-circle__list'], targetCount: 2, duration: 1.47, ease: 'linear', props: { rotate: 360 } },
      { targets: ['div.rotate-circle__image'], targetCount: 8, duration: 1.47, ease: 'linear', props: { rotate: 360 } },
    ],
  };
  const animations = scrollTriggerAnimations({ scrollTriggers: [st] }, []);
  expect(animations).toHaveLength(2);
  expect(animations.every(a => a.count === 1)).toBe(true);
});

test('grouping: a single tween is unchanged (no count suffix, layers preserved)', () => {
  const st = { i: 1, trigger: 'footer', scrub: true, anims: [{ targets: ['div.sun'], targetCount: 1, duration: 1.47, ease: 'none', props: { yPercent: 50 } }] };
  const [entry] = scrollTriggerAnimations({ scrollTriggers: [st] }, []);
  expect(entry.count).toBe(1);
  expect(entry.layers).toBe(1);
  expect(entry.label).not.toMatch(/×/);
  expect(entry.notes).not.toMatch(/grouped/);
});

/* ---------- (a) vendor de-rank ---------- */

test('vendorAnimationMatch: Shop Pay shimmer is recognized by keyframe and selector', () => {
  expect(
    vendorAnimationMatch({ id: 'css-loop-0-acceleratedcheckoutloadingskeleton-div-wallet-cart-button' }),
  ).toMatch(/Shop Pay/);
  expect(vendorAnimationMatch({ selector: 'div.wallet-cart-button__skeleton' })).toMatch(/Shop Pay/);
});

test('vendorAnimationMatch: other known vendors match; real site motion does not', () => {
  expect(vendorAnimationMatch({ id: 'css-loop-intercom-launcher' })).toMatch(/Intercom/);
  expect(vendorAnimationMatch({ selector: '#onetrust-banner-sdk' })).toMatch(/OneTrust/);
  expect(vendorAnimationMatch({ id: 'scrolltrigger-2-0-div-hero', selector: 'div.hero__title' })).toBe(null);
});

test('rendering: tagged vendor animation is excluded from signature and labeled', () => {
  const spec = {
    meta: { url: 'https://shop.example/' },
    patterns: [],
    unspecced: [],
    animations: [
      {
        id: 'css-loop-0-acceleratedcheckoutloadingskeleton-div-wallet-cart-button-skeleton',
        label: 'Wallet cart button skeleton CSS loop',
        selector: 'div.wallet-cart-button__skeleton',
        trigger: 'load',
        mechanism: 'CSS keyframes',
        layers: 1,
        confidence: 'measured',
        lead: { duration: '4s infinite', ease: 'ease' },
      },
      {
        id: 'css-hover-0-a-social',
        label: 'Social link hover',
        selector: 'a.social',
        trigger: 'hover',
        mechanism: 'opacity',
        layers: 1,
        confidence: 'unknown - verify',
        lead: { duration: '0.25s', ease: 'ease-out' },
      },
    ],
  };
  tagVendorAnimations(spec);
  expect(spec.animations[0].vendor).toBe('Shopify Shop Pay / accelerated checkout');
  expect(spec.animations[0].notes).toMatch(/de-ranked from the signature tier/);

  const md = renderAnimationsMarkdown(spec);
  const sig = md.slice(md.indexOf('## Signature moments'), md.indexOf('## Patterns'));
  expect(/acceleratedcheckout/i.test(sig)).toBe(false);
  const vendorSection = md.slice(md.indexOf('## Third-party / vendor'));
  expect(vendorSection).toMatch(/Shopify Shop Pay/);
  expect(vendorSection).toMatch(/excluded from signature/);
});
