import { executeChain } from './executor.js';
import { presentResult } from './presenter.js';
import { enforcePolicy } from './policy.js';
import { sha256, writeTrace } from './trace.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export async function run(command, cfg, opts = {}) {
  const pol = enforcePolicy(command, opts);
  if (!pol.ok) {
    return {
      ok: false,
      exitCode: 403,
      output: `${pol.error}\n[exit:403 | 0ms]`
    };
  }

  const raw = await executeChain(command, cfg);

  if (raw.exitCode === 127 && /command not found/i.test(raw.stderr.toString('utf8'))) {
    const hint = `[error] unknown command. Available: cat, ls, grep, mgrep, find, head, tail, wc, echo, pwd, sort, uniq, sed, awk\n`;
    raw.stderr = Buffer.concat([Buffer.from(hint), raw.stderr]);
  }

  if (pol.policyClass === 'B') {
    const auditPath = cfg.auditFile || cfg.traceFile.replace(/run-trace\.jsonl$/, 'audit.log');
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${new Date().toISOString()}\t${command}\n`, 'utf8');
  }

  const presented = await presentResult(raw, {}, cfg);

  writeTrace(cfg.traceFile, {
    timestamp: new Date().toISOString(),
    command_raw: command,
    cwd: cfg.cwd,
    policy_class: pol.policyClass,
    exit_code: raw.exitCode,
    duration_ms: raw.durationMs,
    stdout_sha256: sha256(raw.stdout),
    stderr_sha256: sha256(raw.stderr),
    truncated: presented.truncated,
    artifact_path: presented.artifactPath || null
  });

  return {
    ok: raw.exitCode === 0,
    exitCode: raw.exitCode,
    output: presented.output,
    artifactPath: presented.artifactPath || null,
    truncated: presented.truncated
  };
}
