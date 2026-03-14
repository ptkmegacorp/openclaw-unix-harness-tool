import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { getConfig } from '../src/config.js';

const sandboxAvailable = false;

function cfgFor(dir) {
  process.env.HARNESS_ROOT = dir;
  process.env.HARNESS_CWD = dir;
  process.env.HARNESS_USE_LLM_PRESENTER = '0';
  return getConfig();
}

test('A) unix semantics integrity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const cfg = cfgFor(dir);

  let r = await run('echo a | wc -c', cfg);
  assert.match(r.output, /2/);

  r = await run('false && echo x', cfg);
  assert.doesNotMatch(r.output, /\nx\n/);

  r = await run('false || echo ok', cfg);
  assert.match(r.output, /ok/);

  r = await run('echo a ; echo b', cfg);
  assert.match(r.output, /b/);
  rmSync(dir, { recursive: true, force: true });
});

test('B/C) layer separation + overflow artifact', { skip: !sandboxAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const cfg = cfgFor(dir);
  const r = await run('seq 1 5000 | wc -l', cfg);
  assert.match(r.output, /5000/);

  const r2 = await run('seq 1 1000', cfg);
  assert.equal(r2.truncated, true);
  assert.ok(r2.artifactPath && existsSync(r2.artifactPath));
  const full = readFileSync(r2.artifactPath, 'utf8');
  assert.match(full, /1000/);
  rmSync(dir, { recursive: true, force: true });
});

test('D) binary guard and text non-binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  writeFileSync(join(dir, 'a.bin'), Buffer.from([0, 159, 1, 2, 3]));
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  const cfg = cfgFor(dir);

  const r = await run('cat a.bin', cfg);
  assert.match(r.output, /binary output detected/);

  const t = await run('cat a.txt', cfg);
  assert.match(t.output, /hello/);
  rmSync(dir, { recursive: true, force: true });
});

test('mgrep direct/recursive/stdin/topk/threshold/no-match/help/integration + backward compat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-mgrep-'));
  const cfg = cfgFor(dir);
  writeFileSync(join(dir, 'a.txt'), 'apple banana\nerror connecting to db\nnetwork timeout\n');
  writeFileSync(join(dir, 'b.txt'), 'database connection failed\nall good\n');
  const nested = join(dir, 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'c.txt'), 'db connectivity issue\n');

  let r = await run('mgrep "database connection error" a.txt b.txt', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /a\.txt:\d+:0\.\d{3}:/);

  r = await run('mgrep query "database connection error" a.txt b.txt', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /a\.txt:\d+:0\.\d{3}:/);

  r = await run('mgrep -r "connect db" .', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /nested\/c\.txt:/);

  r = await run('cat a.txt | mgrep "network timeout"', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /stdin:3:/);

  r = await run('mgrep -k 1 -t 0.30 "connection" a.txt b.txt', cfg);
  assert.equal(r.exitCode, 0);
  const lines = r.output.split('\n').filter((l) => /:\d+:0\.\d{3}:/.test(l));
  assert.equal(lines.length, 1);

  r = await run('mgrep -t 0.99 "totally unrelated" a.txt', cfg);
  assert.equal(r.exitCode, 1);

  r = await run('mgrep --wat "x" a.txt', cfg);
  assert.equal(r.exitCode, 2);
  assert.match(r.output, /unknown flag/i);

  r = await run('mgrep --help', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /semantic grep/i);

  rmSync(dir, { recursive: true, force: true });
});

test('mgrep index build/incremental/status/clear/cache fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-mgrep-index-'));
  const cfg = cfgFor(dir);
  writeFileSync(join(dir, 'a.txt'), 'alpha beta\ndatabase timeout error\n');
  writeFileSync(join(dir, 'b.txt'), 'connection refused\nretry with backoff\n');

  let r = await run('mgrep index .', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /indexed 2 files/);

  r = await run('mgrep index --status .', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /index: present/);
  assert.match(r.output, /files: 2/);

  r = await run('mgrep "database timeout" .', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /using cached index/);

  writeFileSync(join(dir, 'a.txt'), 'alpha beta\ndatabase timeout error\nnew line after change\n');
  r = await run('mgrep index .', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /updated/);

  r = await run('mgrep -r --cache-ttl-sec 0 "new line after change" .', cfg);
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.output, /using cached index/);

  r = await run('mgrep index --clear .', cfg);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /cleared index/);

  r = await run('mgrep index --status .', cfg);
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /index: missing/);

  rmSync(dir, { recursive: true, force: true });
});

test('E/F/G/H/I) stderr, safety, budgets, trace, recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const cfg = cfgFor(dir);

  let r = await run('ls does-not-exist', cfg);
  assert.match(r.output, /\[stderr\]/);

  r = await run('rm -rf /tmp/nope', cfg);
  assert.equal(r.exitCode, 403);
  assert.match(r.output, /confirmDelete=true/);

  r = await run('echo 1;' + Array.from({ length: 20 }).map(() => 'echo x').join(';'), cfg);
  assert.match(r.output, /chain too long/);

  r = await run('sleep 2', { ...cfg, timeoutMs: 50 });
  assert.equal(r.exitCode, 403);
  assert.match(r.output, /confirmWrite=true/);

  r = await run('sleep 2', { ...cfg, timeoutMs: 50 }, { confirmWrite: true, confirmSure: true });
  if (r.exitCode === 124) assert.equal(r.exitCode, 124);
  else assert.match(r.output, /sandbox backend unavailable/i);

  r = await run('this_command_should_not_exist_zzz', cfg);
  assert.equal(r.exitCode, 403);
  assert.match(r.output, /confirmWrite=true/);

  r = await run('this_command_should_not_exist_zzz', cfg, { confirmWrite: true, confirmSure: true });
  if (r.exitCode === 127) {
    assert.match(r.output, /unknown command/i);
  } else {
    assert.match(r.output, /sandbox backend unavailable/i);
  }

  r = await run('touch demo.txt', cfg);
  assert.equal(r.exitCode, 403);
  assert.match(r.output, /confirmWrite=true/);

  await run('touch demo.txt', cfg, { confirmWrite: true });
  const audit = readFileSync(join(dir, 'logs/audit.log'), 'utf8');
  assert.match(audit, /touch demo.txt/);

  r = await run('python3 - <<\'PY\'\nprint("😀"*30000)\nPY', cfg);
  assert.doesNotMatch(r.output, /�/);

  const tracePath = join(dir, 'logs/run-trace.jsonl');
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(trace.length >= 4);
  assert.ok(trace[0].stdout_sha256);
  assert.ok(Object.hasOwn(trace[0], 'truncated'));

  rmSync(dir, { recursive: true, force: true });
});
