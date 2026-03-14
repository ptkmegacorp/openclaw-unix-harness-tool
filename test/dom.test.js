import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { getConfig } from '../src/config.js';

function cfgFor(dir) {
  process.env.HARNESS_ROOT = dir;
  process.env.HARNESS_CWD = dir;
  process.env.HARNESS_TRACE_FILE = join(dir, 'logs/run-trace.jsonl');
  process.env.HARNESS_AUDIT_FILE = join(dir, 'logs/audit.log');
  process.env.HARNESS_USE_LLM_PRESENTER = '0';
  process.env.HARNESS_DOM_ENABLED = '1';
  return getConfig();
}

function seedHtml(dir) {
  writeFileSync(join(dir, 'sample.html'), `<!doctype html><html><head><title>Demo Page</title></head><body>
    <h1>Welcome</h1><p id="intro">hello pricing world</p>
    <a href="https://example.com/docs">Docs</a><a href="/pricing">Pricing</a>
  </body></html>`);
}

test('dom query selector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html query "a" --top 1 --text', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"query"/);
  assert.match(r.output, /"count":1/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom find-text with context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html find-text "pricing" --context 10', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"find-text"/);
  assert.match(r.output, /pricing/i);
  rmSync(dir, { recursive: true, force: true });
});

test('dom extract links contains filter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html extract links --contains docs', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"extract links"/);
  assert.match(r.output, /example.com\/docs/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom snapshot compact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html snapshot --schema compact', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"schema":"compact"/);
  assert.match(r.output, /"title":"Demo Page"/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom toggle disabled deterministic error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  process.env.HARNESS_DOM_ENABLED = '0';
  const r = await run('dom --file sample.html query "a"', cfg);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.output, /dom harness disabled/);
  process.env.HARNESS_DOM_ENABLED = '1';
  rmSync(dir, { recursive: true, force: true });
});

test('dom malformed args and help', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  let r = await run('dom --help', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /DOM harness/);
  r = await run('dom --file sample.html query', cfg);
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /usage:/i);
  rmSync(dir, { recursive: true, force: true });
});
