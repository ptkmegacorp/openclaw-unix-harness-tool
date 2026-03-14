import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseChain } from './parser.js';

const BUILTIN_BIN = fileURLToPath(new URL('../bin', import.meta.url));

export async function executeChain(command, cfg = {}) {
  const start = Date.now();
  const parsed = parseChain(command);
  const maxSegments = cfg.maxSegments ?? 12;
  if (parsed.segments.length > maxSegments) {
    return fail(`[error] chain too long: ${parsed.segments.length} segments (max ${maxSegments}). Split command and retry.`);
  }

  let prevExit = 0;
  let finalStdout = Buffer.alloc(0);
  let finalStderr = Buffer.alloc(0);

  for (let i = 0; i < parsed.segments.length; i++) {
    const seg = parsed.segments[i];
    if (i > 0) {
      const op = parsed.ops[i - 1];
      if (op === '&&' && prevExit !== 0) continue;
      if (op === '||' && prevExit === 0) continue;
    }
    const result = await execSegment(seg, cfg.timeoutMs ?? 60000, cfg.cwd, cfg.root);
    prevExit = result.exitCode;
    finalStdout = result.stdout;
    finalStderr = result.stderr;
  }

  return {
    ok: true,
    exitCode: prevExit,
    stdout: finalStdout,
    stderr: finalStderr,
    durationMs: Date.now() - start
  };
}

function execSegment(segment, timeoutMs, cwd, root) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    const pathParts = [BUILTIN_BIN];
    if (root) pathParts.push(`${root}/bin`);
    pathParts.push(env.PATH || '');
    env.PATH = pathParts.join(':');
    const child = spawn('bash', ['-c', segment], { cwd, env });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => out.push(Buffer.from(d)));
    child.stderr.on('data', (d) => err.push(Buffer.from(d)));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const e = Buffer.from(`[error] timeout: command exceeded ${timeoutMs}ms limit\n`);
        resolve({ exitCode: 124, stdout: Buffer.concat(out), stderr: Buffer.concat([...err, e]) });
        return;
      }
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e.message)) });
    });
  });
}

function fail(stderr) {
  return { ok: false, exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr), durationMs: 0 };
}
