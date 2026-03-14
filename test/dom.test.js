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
    <section id="pricing"><h3>Starter</h3><p class="desc">Great value</p><button class="cta">Buy Now</button><a href="/buy">Buy</a></section>
    <ul><li class="price">$10</li><li class="price">$20</li></ul>
    <form id="signup"><label>Email</label><input name="email" value="" /></form>
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

test('dom pick selector with field extraction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html pick "section" --fields "title:h3,text:.desc,href:a@href"', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"pick"/);
  assert.match(r.output, /"title":"Starter"/);
  assert.match(r.output, /"href":"\/buy"/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom near finds closest within and extracts returns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html near "email" --within "form,section" --return "input@name,input@value"', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"near"/);
  assert.match(r.output, /"found":true/);
  assert.match(r.output, /"spec":"input@name"/);
  assert.match(r.output, /"email"/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom diff compares two snapshots from files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  writeFileSync(join(dir, 'left.json'), JSON.stringify({ title: 'A', counts: { links: 1 } }));
  writeFileSync(join(dir, 'right.json'), JSON.stringify({ title: 'B', counts: { links: 2 }, extra: true }));
  const r = await run('dom diff left.json right.json', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"diff"/);
  assert.match(r.output, /"added":1/);
  assert.match(r.output, /"changed":2/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom diff compares stdin pair JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  const r = await run("printf '[{\"a\":1},{\"a\":2,\"b\":3}]' | dom diff", cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"diff"/);
  assert.match(r.output, /"added":1/);
  assert.match(r.output, /"changed":1/);
  rmSync(dir, { recursive: true, force: true });
});

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

    r = await run(`dom --url ${baseUrl} act wait-text "ready" --timeout-ms 3000`, cfg);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /"cmd":"act wait-text"/);

    r = await run(`dom --url ${baseUrl} act snapshot --schema compact`, cfg);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /"cmd":"act snapshot"/);
  });

  rmSync(dir, { recursive: true, force: true });
});



test('dom glance returns compact deterministic structure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html glance --top 3', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"glance"/);
  assert.match(r.output, /"schema":"compact-v1"/);
  assert.match(r.output, /"title":"Demo Page"/);
  assert.match(r.output, /"counts":\{"links":3,"forms":1,"buttons":1,"inputs":1,"tables":0,"lists":1,"sections":1\}/);
  assert.match(r.output, /"headings":\[/);
  assert.match(r.output, /"topIds":\[/);
  assert.match(r.output, /"topClasses":\[/);
  assert.match(r.output, /"landmarks":\[/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom glance malformed args and help', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);

  let r = await run('dom --file sample.html glance --help', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /dom \[--url .* glance/);

  r = await run('dom --file sample.html glance nope', cfg);
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /dom \[--url .* glance/);

  rmSync(dir, { recursive: true, force: true });
});
test('dom path selector mode emits deterministic path rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html path --selector ".price" --top 1', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"path"/);
  assert.match(r.output, /"mode":"selector"/);
  assert.match(r.output, /"tag":"li"/);
  assert.match(r.output, /"cssPath":"/);
  assert.match(r.output, /"ancestry":\[/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom path text mode finds Buy Now and supports style/depth/top', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html path --text "Buy Now" --style ancestry --depth 3 --top 1', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"mode":"text"/);
  assert.match(r.output, /"style":"ancestry"/);
  assert.match(r.output, /"count":1/);
  assert.match(r.output, /"ancestry":\[(?:.|\n)*\]/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom path supports pipeline input from dom pick jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  const r = await run('dom --file sample.html pick ".price" --fields "id:.@id,text:." --jsonl | dom --file sample.html path --depth 3 --top 2', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /"cmd":"path"/);
  assert.match(r.output, /"mode":"stdin"/);
  assert.match(r.output, /"count":2/);
  rmSync(dir, { recursive: true, force: true });
});

test('dom path malformed args and help', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);

  let r = await run('dom --help', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /dom .* path --selector/);
  assert.match(r.output, /dom .* glance/);

  r = await run('dom --file sample.html path --selector "a" --text "Buy"', cfg);
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /either --selector or --text/);

  r = await run('dom --file sample.html path --selector "a" --style nope', cfg);
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /--style must be one of/);

  // stdin-only mode is exercised in pipeline tests.

  rmSync(dir, { recursive: true, force: true });
});

test('dom malformed args and help', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-'));
  const cfg = cfgFor(dir);
  seedHtml(dir);
  let r = await run('dom --help', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /DOM harness/);
  r = await run('dom --file sample.html pick "section"', cfg);
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /requires --fields/i);
  r = await run('dom diff --left left.json', cfg);
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /requires both --left and --right/);
  rmSync(dir, { recursive: true, force: true });
});
