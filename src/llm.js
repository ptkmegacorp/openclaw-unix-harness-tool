function tokenize(input) {
  const out = [];
  let buf = '';
  let q = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (q) {
      if (ch === q) {
        q = null;
      } else if (ch === '\\' && q === '"' && i + 1 < input.length) {
        buf += input[++i];
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function parseFlags(args) {
  const flags = { format: 'text' };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.format = 'json';
    else if (a === '--text') flags.format = 'text';
    else if (a === '--system') flags.system = args[++i] ?? '';
    else if (a === '--model') flags.model = args[++i] ?? '';
    else if (a === '--temp') flags.temp = Number(args[++i]);
    else if (a === '--max-tokens') flags.maxTokens = Number(args[++i]);
    else positional.push(a);
  }
  return { flags, positional };
}

function asResult(obj, format = 'json', exitCode = 0) {
  const out = format === 'json' ? `${JSON.stringify(obj)}\n` : toText(obj);
  return { backend: 'native', exitCode, stdout: Buffer.from(out), stderr: Buffer.alloc(0) };
}

function errResult(message, code = 2) {
  return { backend: 'native', exitCode: code, stdout: Buffer.alloc(0), stderr: Buffer.from(`[error] ${message}\n`) };
}

function toText(obj) {
  if (obj.kind === 'health') {
    const lines = obj.endpoints.map((e) => `${e.endpoint}\tok=${e.ok ? 1 : 0}\tstatus=${e.status ?? '-'}\tlatency_ms=${e.latencyMs ?? '-'}${e.error ? `\terror=${e.error}` : ''}`);
    return `${lines.join('\n')}\n`;
  }
  if (obj.kind === 'models') return `${obj.models.join('\n')}${obj.models.length ? '\n' : ''}`;
  if (obj.kind === 'chat') return `${obj.output || ''}\n`;
  if (obj.kind === 'embed') return `${(obj.embedding || []).join(' ')}\n`;
  if (obj.kind === 'tokenize') {
    if (obj.supported) return `${(obj.tokens || []).join(' ')}\n`;
    return `estimate_tokens=${obj.estimateTokens}\n`;
  }
  return `${JSON.stringify(obj)}\n`;
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function withFailover(cfg, fn) {
  const errors = [];
  for (const endpoint of cfg.llmEndpoints || []) {
    try {
      const val = await fn(endpoint);
      if (val?.ok) return { ...val, endpoint, errors };
      errors.push({ endpoint, status: val?.status ?? null, error: val?.error || 'request failed' });
    } catch (e) {
      errors.push({ endpoint, error: String(e?.message || e) });
    }
  }
  return { ok: false, errors };
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

export async function executeLlmSegment(segment, cfg = {}) {
  const argv = tokenize(segment);
  if (argv[0] !== 'llm') return errResult('invalid llm command');
  if (!cfg.llmToolsEnabled) return errResult('llm tools disabled (set HARNESS_LLM_TOOLS_ENABLED=1)', 3);

  const { flags, positional } = parseFlags(argv.slice(1));
  const sub = positional[0];
  const timeoutMs = cfg.llmTimeoutMs ?? 12000;
  const defaultModel = cfg.llmDefaultModel || cfg.llmModel;

  if (!sub || sub === 'help') {
    return asResult({
      ok: true,
      kind: 'help',
      commands: ['llm health', 'llm models', 'llm chat "<prompt>"', 'llm embed "<text>"', 'llm tokenize "<text>"']
    }, flags.format);
  }

  if (sub === 'health') {
    const endpoints = [];
    for (const endpoint of cfg.llmEndpoints || []) {
      const t0 = Date.now();
      try {
        const r = await fetchJson(`${endpoint}/v1/models`, { method: 'GET' }, timeoutMs);
        endpoints.push({ endpoint, ok: r.ok, status: r.status, latencyMs: Date.now() - t0 });
      } catch (e) {
        endpoints.push({ endpoint, ok: false, status: null, latencyMs: Date.now() - t0, error: String(e?.message || e) });
      }
    }
    const out = { ok: endpoints.some((e) => e.ok), kind: 'health', endpoints };
    return asResult(out, flags.format, out.ok ? 0 : 1);
  }

  if (sub === 'models') {
    const resp = await withFailover(cfg, async (endpoint) => {
      const r = await fetchJson(`${endpoint}/v1/models`, { method: 'GET' }, timeoutMs);
      return { ok: r.ok, status: r.status, json: r.json };
    });
    if (!resp.ok) return errResult(`all llm endpoints failed: ${JSON.stringify(resp.errors)}`, 1);
    const models = (resp.json?.data || []).map((m) => m.id).filter(Boolean).sort();
    return asResult({ ok: true, kind: 'models', endpoint: resp.endpoint, models }, flags.format);
  }

  if (sub === 'chat') {
    const prompt = positional[1] || '';
    if (!prompt) return errResult('llm chat requires a prompt, e.g. llm chat "hello"');
    const body = {
      model: flags.model || defaultModel,
      messages: [
        ...(flags.system ? [{ role: 'system', content: flags.system }] : []),
        { role: 'user', content: prompt }
      ],
      temperature: Number.isFinite(flags.temp) ? flags.temp : 0,
      max_tokens: Number.isFinite(flags.maxTokens) ? flags.maxTokens : 256
    };
    const resp = await withFailover(cfg, async (endpoint) => {
      const r = await fetchJson(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
      return { ok: r.ok, status: r.status, json: r.json };
    });
    if (!resp.ok) return errResult(`all llm endpoints failed: ${JSON.stringify(resp.errors)}`, 1);
    const choice = resp.json?.choices?.[0] || {};
    const output = choice?.message?.content ?? '';
    return asResult({ ok: true, kind: 'chat', endpoint: resp.endpoint, model: body.model, output, finishReason: choice?.finish_reason || null, usage: resp.json?.usage || null }, flags.format);
  }

  if (sub === 'embed') {
    const text = positional[1] || '';
    if (!text) return errResult('llm embed requires text, e.g. llm embed "hello"');
    const body = { model: flags.model || defaultModel, input: text };
    const resp = await withFailover(cfg, async (endpoint) => {
      const r = await fetchJson(`${endpoint}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
      if (r.status === 404 || r.status === 501) return { ok: false, status: r.status, error: 'unsupported' };
      return { ok: r.ok, status: r.status, json: r.json };
    });
    const unsupportedOnly = resp.errors?.length && resp.errors.every((e) => e.error === 'unsupported');
    if (!resp.ok && unsupportedOnly) return errResult('llm embed unsupported by configured endpoints', 4);
    if (!resp.ok) return errResult(`all llm endpoints failed: ${JSON.stringify(resp.errors)}`, 1);
    const embedding = resp.json?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) return errResult('llm embed response missing embedding array', 1);
    return asResult({ ok: true, kind: 'embed', endpoint: resp.endpoint, model: body.model, dimensions: embedding.length, embedding }, flags.format);
  }

  if (sub === 'tokenize') {
    const text = positional[1] || '';
    if (!text) return errResult('llm tokenize requires text, e.g. llm tokenize "hello"');
    const resp = await withFailover(cfg, async (endpoint) => {
      const r = await fetchJson(`${endpoint}/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) }, timeoutMs);
      if (r.status === 404 || r.status === 501) return { ok: false, status: r.status, error: 'unsupported' };
      return { ok: r.ok, status: r.status, json: r.json };
    });
    if (!resp.ok) {
      const estimate = estimateTokens(text);
      return asResult({ ok: true, kind: 'tokenize', supported: false, estimateTokens: estimate, estimator: 'chars_div_4' }, flags.format);
    }
    const tokens = resp.json?.tokens || [];
    if (!Array.isArray(tokens)) {
      const estimate = estimateTokens(text);
      return asResult({ ok: true, kind: 'tokenize', supported: false, estimateTokens: estimate, estimator: 'chars_div_4' }, flags.format);
    }
    return asResult({ ok: true, kind: 'tokenize', endpoint: resp.endpoint, supported: true, tokenCount: tokens.length, tokens }, flags.format);
  }

  return errResult(`unknown llm subcommand: ${sub}`);
}
