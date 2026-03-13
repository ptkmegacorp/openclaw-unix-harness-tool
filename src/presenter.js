import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function isLikelyBinary(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if ((b < 7 || (b > 13 && b < 32)) && b !== 9 && b !== 10 && b !== 13) suspicious++;
  }
  return suspicious / sample.length > 0.2;
}

export async function presentResult(raw, ctx, cfg) {
  const maxLines = cfg.maxLines ?? 200;
  const maxBytes = cfg.maxReturnBytes ?? 50 * 1024;
  const artifactDir = cfg.artifactDir;
  let text = raw.stdout.toString('utf8');
  let truncated = false;
  let artifactPath = null;

  if (isLikelyBinary(raw.stdout)) {
    return {
      output: `[error] binary output detected. Use a binary-safe command (e.g., xxd, file, or image viewer).\n[exit:${raw.exitCode} | ${raw.durationMs}ms]`,
      truncated: false,
      artifactPath: null
    };
  }

  const lines = text.split('\n');
  if (lines.length > maxLines || Buffer.byteLength(text, 'utf8') > maxBytes) {
    truncated = true;
    mkdirSync(artifactDir, { recursive: true });
    artifactPath = join(artifactDir, `cmd-${Date.now()}.txt`);
    writeFileSync(artifactPath, text, 'utf8');
    text = safeTrim(text, maxBytes, maxLines);
    text += `\n--- output truncated (${lines.length} lines, ${human(Buffer.byteLength(raw.stdout))}) ---\nFull output: ${artifactPath}`;
  }

  if (raw.stderr.length > 0) {
    const errText = safeTrim(raw.stderr.toString('utf8'), maxBytes / 2, 80);
    text = `${text}\n[stderr] ${errText}`;
  }

  const withFooter = `${text}\n[exit:${raw.exitCode} | ${raw.durationMs}ms]`;

  const llmText = await maybeLlmPolish(withFooter, cfg);
  return { output: llmText, truncated, artifactPath };
}

function safeTrim(text, maxBytes, maxLines) {
  let lines = text.split('\n');
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  let s = lines.join('\n');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const part = s.slice(0, mid);
    if (Buffer.byteLength(part, 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

function human(n) {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

async function maybeLlmPolish(text, cfg) {
  if (!cfg.useLlmPresenter) return text;
  const body = {
    model: cfg.llmModel,
    messages: [
      { role: 'system', content: 'You are a formatter. Keep exact technical content and footer, do not omit stderr or exit line. Return plain text only.' },
      { role: 'user', content: text }
    ],
    temperature: 0
  };
  for (const endpoint of cfg.llmEndpoints) {
    try {
      const r = await fetch(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) continue;
      const j = await r.json();
      const out = j?.choices?.[0]?.message?.content;
      if (out && out.includes('[exit:')) return out;
    } catch {}
  }
  return text;
}

export async function llmHealth(cfg) {
  const results = [];
  for (const endpoint of cfg.llmEndpoints) {
    try {
      const r = await fetch(`${endpoint}/v1/models`);
      results.push({ endpoint, ok: r.ok, status: r.status });
    } catch (e) {
      results.push({ endpoint, ok: false, error: String(e.message) });
    }
  }
  return results;
}
