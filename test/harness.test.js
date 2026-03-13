import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { getConfig } from '../src/config.js';

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

test('B/C) layer separation + overflow artifact', async () => {
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

test('E/F/G/H/I) stderr, safety, budgets, trace, recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const cfg = cfgFor(dir);

  let r = await run('ls does-not-exist', cfg);
  assert.match(r.output, /\[stderr\]/);

  r = await run('rm -rf /tmp/nope', cfg);
  assert.equal(r.exitCode, 403);
  assert.match(r.output, /confirm_delete/);

  r = await run('echo 1;' + Array.from({ length: 20 }).map(() => 'echo x').join(';'), cfg);
  assert.match(r.output, /chain too long/);

  r = await run('sleep 2', { ...cfg, timeoutMs: 50 });
  assert.equal(r.exitCode, 124);

  // unknown command suggestion
  r = await run('this_command_should_not_exist_zzz', cfg);
  assert.equal(r.exitCode, 127);
  assert.match(r.output, /unknown command/i);

  // class B audit
  await run('touch demo.txt', cfg);
  const audit = readFileSync(join(dir, 'logs/audit.log'), 'utf8');
  assert.match(audit, /touch demo.txt/);

  // utf-8 safe trim (no replacement char)
  r = await run('python3 - <<\'PY\'\nprint("😀"*30000)\nPY', cfg);
  assert.doesNotMatch(r.output, /�/);

  const tracePath = join(dir, 'logs/run-trace.jsonl');
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(trace.length >= 4);
  assert.ok(trace[0].stdout_sha256);
  assert.ok(Object.hasOwn(trace[0], 'truncated'));

  rmSync(dir, { recursive: true, force: true });
});
