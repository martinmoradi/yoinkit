#!/usr/bin/env bun
'use strict';
/*
 * filter-manifest.js coverage — pure selection, no browser.
 * Focus: --grep validation (a bare --grep must not become /true/i; an invalid
 * regex must fail cleanly) plus the happy --ids / --grep paths.
 */

const { afterEach, expect, test } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skill', 'codex', 'scripts', 'filter-manifest.js');
const tempDirs = new Set();

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-manifest-test-'));
  tempDirs.add(dir);
  const inFile = path.join(dir, 'manifest.proposed.json');
  fs.writeFileSync(inFile, JSON.stringify({
    url: 'https://example.test/', viewport: [1280, 800], captureStrategy: 'reuse-page',
    captures: [
      { id: 'hero-load', type: 'boot', root: 'h1' },
      { id: 'work-card-hover', type: 'hover', root: 'a.card' },
    ],
  }));
  return { dir, inFile };
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('bare --grep fails without writing output', () => {
  // parseArgs would make a bare flag `true`; it must fail, not match all.
  const { dir, inFile } = makeFixture();
  const outFile = path.join(dir, 'a.json');
  const r = run(['--in', inFile, '--out', outFile, '--grep']);

  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/--grep needs a regex value/);
  expect(fs.existsSync(outFile)).toBe(false);
});

test('invalid --grep regex fails cleanly', () => {
  const { dir, inFile } = makeFixture();
  const outFile = path.join(dir, 'b.json');
  const r = run(['--in', inFile, '--out', outFile, '--grep', '(']);

  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/invalid --grep regex/);
});

test('valid --grep selects matching captures', () => {
  const { dir, inFile } = makeFixture();
  const outFile = path.join(dir, 'c.json');
  const r = run(['--in', inFile, '--out', outFile, '--grep', 'card']);

  expect(r.status).toBe(0);
  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  expect(out.captures).toHaveLength(1);
  expect(out.captures[0].id).toBe('work-card-hover');
});

test('--ids exact match selects the named capture', () => {
  const { dir, inFile } = makeFixture();
  const outFile = path.join(dir, 'd.json');
  const r = run(['--in', inFile, '--out', outFile, '--ids', 'hero-load']);

  expect(r.status).toBe(0);
  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  expect(out.captures).toHaveLength(1);
  expect(out.captures[0].id).toBe('hero-load');
});
