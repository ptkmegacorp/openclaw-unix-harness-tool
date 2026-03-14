import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { run } from '../src/run.js';
import { getConfig } from '../src/config.js';

function cfgFor(dir) {
  process.env.HARNESS_ROOT = dir;
  process.env.HARNESS_CWD = dir;
  process.env.HARNESS_TRACE_FILE = join(dir, 'logs/run-trace.jsonl');
  process.env.HARNESS_AUDIT_FILE = join(dir, 'logs/audit.log');
  process.env.HARNESS_USE_LLM_PRESENTER = '0';
  process.env.HARNESS_DOM_ENABLED = '1';
  process.env.HARNESS_DOM_ACT_ENABLED = '1';
  return getConfig();
}

function seedHtml(dir) {
  writeFileSync(join(dir, 'sample.html'), `<!doctype html><html><head><title>Demo Page</title></head><body>
    <h1>Welcome</h1><p id="intro">hello pricing world</p>
    <a href="https://example.com/docs">Docs</a><a href="/pricing">Pricing</a>
  </body></html>`);
}

async function withLocalServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

test('dom act toggle disabled deterministic error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  process.env.HARNESS_DOM_ACT_ENABLED = '0';
  const r = await run('dom --url http://127.0.0.1:65535 act press "Enter"', cfg);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.output, /dom act disabled/);
  process.env.HARNESS_DOM_ACT_ENABLED = '1';
  rmSync(dir, { recursive: true, force: true });
});

test('dom act rejects non-local URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  const r = await run('dom --url https://example.com act snapshot --schema compact', cfg);
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /dom act local-only: URL not allowed/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom act local integration: click/wait-text/snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);

  let hits = 0;
  await withLocalServer((req, res) => {
    hits += 1;
    const ready = hits >= 3;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Act Fixture</title></head><body>
      <button id="go">Go</button>
      <input id="name" value="" />
      <select id="sel"><option value="one">one</option></select>
      <p>${ready ? 'status ready' : 'status waiting'}</p>
    </body></html>`);
  }, async (baseUrl) => {
    let r = await run(`dom --url ${baseUrl} act click "#go"`, cfg);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /"cmd":"act click"/);

    r = await run(`dom --url ${baseUrl} act type "#name" "alice"`, cfg);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /"cmd":"act type"/);

    r = await run(`dom --url ${baseUrl} act select "#sel" "one"`, cfg);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /"cmd":"act select"/);

    r = await run(`dom --url ${baseUrl} act press "Enter"`, cfg);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /"cmd":"act press"/);

    r = await run(`dom --url ${baseUrl} act wait-text "ready" --timeout-ms 3000`, cfg);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /"cmd":"act wait-text"/);

    r = await run(`dom --url ${baseUrl} act snapshot --schema compact`, cfg);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /"cmd":"act snapshot"/);
    assert.match(r.output, /"schema":"compact"/);
  });

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
