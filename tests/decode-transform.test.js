#!/usr/bin/env bun
/* Unit tests for the engine's matrix decoder (window.__cap._decodeTransform).
 *
 * Pure math, no browser: the single engine file is loaded in a vm context with
 * minimal browser shims so we can call decodeTransform directly. The point is
 * the degenerate-scale rotation guard — a collapsed axis must NOT decode to a
 * spurious rotation, while a genuine rotation must still decode correctly. */
'use strict';

const { beforeAll, expect, test } = require('bun:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE = path.join(__dirname, '..', 'extension', 'capture-animation.js');

let decode;

function approx(a, b, eps = 0.05) { return Math.abs(a - b) <= eps; }

beforeAll(() => {
  const src = fs.readFileSync(ENGINE, 'utf8');

  // Just enough of a browser for the engine's top-level code to load. None of
  // these are exercised by decodeTransform itself.
  const noop = () => {};
  const ctx = {
    console: { log: noop, warn: console.warn, error: console.error },
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    performance: { now: () => 0 },
    getComputedStyle: () => ({}),
    document: { documentElement: {}, body: {}, addEventListener: noop,
                querySelectorAll: () => [], createElement: () => ({ style: {} }) },
    CSS: { escape: s => String(s) },
  };
  ctx.window = ctx;            // engine uses both `window.x` and bare globals
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: ENGINE });

  decode = ctx.window.__cap._decodeTransform;
  if (typeof decode !== 'function') {
    throw new Error('__cap._decodeTransform not exposed');
  }
});

test('collapsed scale axes suppress bogus rotation', () => {
  // Collapsed scaleX (matrix(0,0,0,1,0,0)): scaleX 0, scaleY 1, NO rotation.
  const collapsed = decode('matrix(0,0,0,1,0,0)');
  expect(approx(collapsed.scaleX, 0)).toBe(true);
  expect(approx(collapsed.scaleY, 1)).toBe(true);
  expect(collapsed.rotate).toBe(0);

  // The same axis with realistic browser float residuals must still yield 0,
  // not the amplified ~90deg the un-guarded atan2 produced.
  const noisy = decode('matrix(1e-16, 2e-16, -3e-17, 1, 0, 0)');
  expect(noisy.rotate).toBe(0);
});

test('real 2D rotation decodes without triggering the guard', () => {
  const rot = decode('matrix(0,1,-1,0,0,0)');
  expect(approx(rot.scaleX, 1)).toBe(true);
  expect(approx(rot.scaleY, 1)).toBe(true);
  expect(approx(rot.rotate, 90)).toBe(true);
});

test('small non-collapsed scale preserves rotation', () => {
  // A 45deg rotation uniformly scaled to 0.01, well above the 1e-3 epsilon.
  const s = 0.01, ang = Math.PI / 4;
  const small = decode(`matrix(${s * Math.cos(ang)},${s * Math.sin(ang)},${-s * Math.sin(ang)},${s * Math.cos(ang)},0,0)`);
  expect(approx(small.rotate, 45)).toBe(true);
});

test('3D collapsed axes are guarded while real 3D rotation decodes', () => {
  // matrix3d is column-major: X col (residuals), Y col (0,1,0), Z col (0,0,1).
  const m3d = decode('matrix3d(1e-16,2e-16,1e-16,0, 0,1,0,0, 0,0,1,0, 0,0,0,1)');
  expect(approx(m3d.scaleX, 0)).toBe(true);
  expect(m3d.rotateY).toBe(0);
  expect(m3d.rotateZ).toBe(0);

  const m3dRot = decode('matrix3d(0,1,0,0, -1,0,0,0, 0,0,1,0, 0,0,0,1)');
  expect(approx(Math.abs(m3dRot.rotateZ), 90)).toBe(true);
});
