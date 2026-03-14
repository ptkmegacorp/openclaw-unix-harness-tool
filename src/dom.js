import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';

const MAX_TEXT = 200;

export async function runDomCli(argv, cfg = {}) {
  const enabled = String(process.env.HARNESS_DOM_ENABLED ?? cfg.domEnabled ?? '1') === '1';
  if (!enabled) return fail('dom harness disabled (HARNESS_DOM_ENABLED=0)', 3);

  if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') {
    return ok(helpText());
  }

  const { source, rest } = parseSource(argv);
  const cmd = rest[0];
  if (!cmd) return fail('missing dom subcommand. Try: dom --help', 2);

  if (cmd === 'act') return runAct(rest.slice(1), source, cfg);

  if (cmd === 'diff') return runDiff(rest.slice(1), cfg);

  const html = await loadHtml(source, cfg);
  const $ = cheerio.load(html);

  if (cmd === 'query') {
    const selector = rest[1];
    if (!selector) return fail('usage: dom [--url U|--file F] query "<selector>" [--top N] [--text]', 2);
    const top = Number(readFlag(rest, '--top', '20'));
    const includeText = rest.includes('--text');
    const rows = $(selector)
      .slice(0, Number.isFinite(top) && top > 0 ? top : 20)
      .toArray()
      .map((el, idx) => {
        const node = $(el);
        const item = {
          i: idx,
          tag: (el.tagName || '').toLowerCase(),
          id: node.attr('id') || null,
          cls: (node.attr('class') || '').trim().replace(/\s+/g, '.') || null
        };
        if (includeText) item.text = compactText(node.text(), MAX_TEXT);
        return item;
      });
    return ok(JSON.stringify({ cmd: 'query', selector, count: rows.length, rows }, null, 0));
  }

  if (cmd === 'pick') {
    return runPick($, rest.slice(1));
  }

  if (cmd === 'near') {
    return runNear($, rest.slice(1));
  }

  if (cmd === 'find-text') {
    const needle = (rest[1] || '').toLowerCase();
    if (!needle) return fail('usage: dom [--url U|--file F] find-text "<text>" [--context N]', 2);
    const context = Math.max(0, Number(readFlag(rest, '--context', '40')) || 40);
    const out = [];
    $('*').toArray().forEach((el) => {
      if (out.length >= 50) return;
      const text = compactText($(el).text(), 2000);
      const hay = text.toLowerCase();
      const at = hay.indexOf(needle);
      if (at >= 0) {
        const start = Math.max(0, at - context);
        const end = Math.min(text.length, at + needle.length + context);
        out.push({
          tag: (el.tagName || '').toLowerCase(),
          id: $(el).attr('id') || null,
          text: text.slice(start, end)
        });
      }
    });
    return ok(JSON.stringify({ cmd: 'find-text', text: rest[1], count: out.length, rows: out }, null, 0));
  }

  if (cmd === 'extract' && rest[1] === 'links') {
    const contains = (readFlag(rest, '--contains', '') || '').toLowerCase();
    const rows = $('a[href]').toArray().map((a) => ({
      href: $(a).attr('href') || '',
      text: compactText($(a).text(), MAX_TEXT)
    }))
      .filter((r) => !contains || r.href.toLowerCase().includes(contains) || r.text.toLowerCase().includes(contains))
      .slice(0, 200);
    return ok(JSON.stringify({ cmd: 'extract links', count: rows.length, rows }, null, 0));
  }

  if (cmd === 'snapshot') {
    const schema = readFlag(rest, '--schema', 'compact');
    if (schema !== 'compact') return fail('only --schema compact is supported', 2);
    return ok(snapshotCompact($, 'snapshot'));
  }

  return fail('unknown dom subcommand. Try: dom --help', 2);
}

function runPick($, argv) {
  const selector = argv[0];
  if (!selector) return fail('usage: dom [--url U|--file F] pick "<selector>" --fields "name:sel,name2:sel@attr" [--top N] [--jsonl]', 2);
  const fieldsRaw = readFlag(argv, '--fields', '');
  if (!fieldsRaw) return fail('dom pick requires --fields "name:selector,..."', 2);
  const fields = parseNamedFieldSpecs(fieldsRaw);
  if (!fields.ok) return fail(fields.error, 2);
  const top = Math.max(1, Number(readFlag(argv, '--top', '50')) || 50);
  const rows = $(selector).slice(0, top).toArray().map((el, idx) => {
    const row = { i: idx };
    for (const f of fields.specs) {
      row[f.name] = extractSingle($, $(el), f.target);
    }
    return row;
  });
  if (argv.includes('--jsonl')) return ok(rows.map((r) => JSON.stringify(r)).join('\n'));
  return ok(JSON.stringify({ cmd: 'pick', selector, count: rows.length, rows }, null, 0));
}

function runNear($, argv) {
  const needle = argv[0];
  if (!needle) return fail('usage: dom [--url U|--file F] near "<needle text>" --within "form,section" --return "input@name,input@value"', 2);
  const withinRaw = readFlag(argv, '--within', 'body');
  const returnRaw = readFlag(argv, '--return', '');
  if (!returnRaw) return fail('dom near requires --return "selector@attr,..."', 2);

  const withinSelectors = withinRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const returnSpecs = parseReturnSpecs(returnRaw);
  if (!returnSpecs.ok) return fail(returnSpecs.error, 2);

  const candidates = [];
  for (const scopeSel of withinSelectors) {
    $(scopeSel).toArray().forEach((el) => {
      const text = compactText($(el).text(), 4000);
      const at = text.toLowerCase().indexOf(needle.toLowerCase());
      if (at >= 0) {
        const depth = depthOf(el);
        candidates.push({ el, scopeSel, textLen: text.length, at, depth, text });
      }
    });
  }

  if (candidates.length === 0) {
    return ok(JSON.stringify({ cmd: 'near', needle, found: false, within: withinSelectors, returns: [] }, null, 0));
  }

  candidates.sort((a, b) => (a.textLen - b.textLen) || (a.depth - b.depth) || (a.at - b.at));
  const best = candidates[0];
  const ctx = $(best.el);
  const returns = returnSpecs.specs.map((s) => ({
    spec: s.raw,
    values: extractMany($, ctx, s)
  }));

  return ok(JSON.stringify({
    cmd: 'near',
    needle,
    found: true,
    within: withinSelectors,
    context: {
      tag: (best.el.tagName || '').toLowerCase(),
      id: ctx.attr('id') || null,
      cls: (ctx.attr('class') || '').trim().replace(/\s+/g, '.') || null,
      text: compactText(best.text, 240)
    },
    returns
  }, null, 0));
}

async function runDiff(argv, cfg) {
  if (argv.includes('--help') || argv[0] === 'help') {
    return ok('usage: dom diff [left.json right.json]\n   or: dom diff --left left.json --right right.json\n   or: cat pair.json | dom diff');
  }

  let leftRaw = null;
  let rightRaw = null;

  const leftFile = readFlag(argv, '--left');
  const rightFile = readFlag(argv, '--right');
  if (leftFile || rightFile) {
    if (!leftFile || !rightFile) return fail('dom diff requires both --left and --right', 2);
    leftRaw = await readFile(resolve(cfg.cwd || process.cwd(), leftFile), 'utf8');
    rightRaw = await readFile(resolve(cfg.cwd || process.cwd(), rightFile), 'utf8');
  } else if (argv.length >= 2) {
    leftRaw = await readFile(resolve(cfg.cwd || process.cwd(), argv[0]), 'utf8');
    rightRaw = await readFile(resolve(cfg.cwd || process.cwd(), argv[1]), 'utf8');
  } else {
    const stdin = await readStdin();
    if (!stdin.trim()) return fail('dom diff expects two snapshots via args/files or stdin JSON', 2);
    const pair = parseSnapshotPair(stdin);
    if (!pair.ok) return fail(pair.error, 2);
    leftRaw = JSON.stringify(pair.left);
    rightRaw = JSON.stringify(pair.right);
  }

  const left = parseJson(leftRaw, 'left');
  const right = parseJson(rightRaw, 'right');
  if (!left.ok) return fail(left.error, 2);
  if (!right.ok) return fail(right.error, 2);

  const summary = diffObjects(left.value, right.value);
  return ok(JSON.stringify({ cmd: 'diff', ...summary }, null, 0));
}

function diffObjects(a, b) {
  const leftMap = flatten(a);
  const rightMap = flatten(b);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [k, v] of rightMap.entries()) {
    if (!leftMap.has(k)) added.push({ path: k, value: v });
  }
  for (const [k, v] of leftMap.entries()) {
    if (!rightMap.has(k)) removed.push({ path: k, value: v });
    else if (!isEqualPrimitive(v, rightMap.get(k))) changed.push({ path: k, from: v, to: rightMap.get(k) });
  }

  const keyChanges = {
    added: added.slice(0, 20).map((x) => x.path),
    removed: removed.slice(0, 20).map((x) => x.path),
    changed: changed.slice(0, 20).map((x) => x.path)
  };

  return {
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    keyPaths: keyChanges
  };
}

function flatten(value, base = '$', out = new Map()) {
  if (value === null || typeof value !== 'object') {
    out.set(base, value);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(base, []);
    value.forEach((item, i) => flatten(item, `${base}[${i}]`, out));
    return out;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) out.set(base, {});
  for (const k of keys) flatten(value[k], `${base}.${k}`, out);
  return out;
}

function parseNamedFieldSpecs(raw) {
  try {
    const specs = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const i = entry.indexOf(':');
      if (i <= 0 || i === entry.length - 1) throw new Error(`invalid field entry: ${entry}`);
      return { name: entry.slice(0, i).trim(), target: parseTarget(entry.slice(i + 1).trim()) };
    });
    if (!specs.length) return { ok: false, error: 'no fields parsed' };
    return { ok: true, specs };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function parseReturnSpecs(raw) {
  try {
    const specs = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => ({ ...parseTarget(entry), raw: entry }));
    if (!specs.length) return { ok: false, error: 'no return specs parsed' };
    return { ok: true, specs };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function parseTarget(raw) {
  const at = raw.lastIndexOf('@');
  if (at > 0 && at < raw.length - 1) {
    return { selector: raw.slice(0, at), attr: raw.slice(at + 1) };
  }
  return { selector: raw, attr: null };
}

function extractSingle($, root, target) {
  const node = target.selector === '.' ? root : root.find(target.selector).first();
  if (!node || !node.length) return null;
  if (target.attr) return node.attr(target.attr) ?? null;
  return compactText(node.text(), MAX_TEXT);
}

function extractMany($, root, target) {
  const nodes = target.selector === '.' ? [root.get(0)] : root.find(target.selector).toArray();
  const out = nodes.map((el) => {
    const node = $(el);
    if (target.attr) return node.attr(target.attr) ?? null;
    return compactText(node.text(), MAX_TEXT);
  }).filter((v) => v !== null && v !== '');
  return out;
}

function parseSnapshotPair(input) {
  try {
    const asJson = JSON.parse(input);
    if (Array.isArray(asJson) && asJson.length >= 2) return { ok: true, left: asJson[0], right: asJson[1] };
    if (asJson && typeof asJson === 'object' && 'left' in asJson && 'right' in asJson) return { ok: true, left: asJson.left, right: asJson.right };
  } catch {
    // try JSONL fallback
  }
  const lines = input.split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const l = parseJson(lines[0], 'stdin line1');
    const r = parseJson(lines[1], 'stdin line2');
    if (l.ok && r.ok) return { ok: true, left: l.value, right: r.value };
  }
  return { ok: false, error: 'stdin must be JSON array [left,right], object {left,right}, or two JSON lines' };
}

function parseJson(raw, label) {
  try {
    return { ok: true, value: typeof raw === 'string' ? JSON.parse(raw) : raw };
  } catch (e) {
    return { ok: false, error: `invalid ${label} JSON: ${String(e.message || e)}` };
  }
}

async function runAct(argv, source, cfg) {
  const enabled = String(process.env.HARNESS_DOM_ACT_ENABLED ?? cfg.domActEnabled ?? '0') === '1';
  if (!enabled) return fail('dom act disabled (HARNESS_DOM_ACT_ENABLED=0)', 3);
  if (!source.url) return fail('dom act requires --url <local-url>', 2);
  if (!isAllowedLocalUrl(source.url)) return fail(`dom act local-only: URL not allowed (${source.url})`, 2);

  const op = argv[0];
  if (!op) return fail('missing dom act command. Try: dom --help', 2);

  if (op === 'wait-text') {
    const text = argv[1];
    if (!text) return fail('usage: dom --url <local-url> act wait-text "<text>" [--timeout-ms N]', 2);
    const timeoutMs = Math.max(1, Number(readFlag(argv, '--timeout-ms', '5000')) || 5000);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const html = await loadHtml(source, cfg);
      const body = compactText(cheerio.load(html)('body').text(), 4000);
      if (body.toLowerCase().includes(text.toLowerCase())) {
        return ok(JSON.stringify({ cmd: 'act wait-text', text, found: true, waitedMs: Date.now() - start }, null, 0));
      }
      await sleep(100);
    }
    return fail(`act wait-text timeout after ${timeoutMs}ms: ${text}`, 4);
  }

  const html = await loadHtml(source, cfg);
  const $ = cheerio.load(html);

  if (op === 'click') {
    const selector = argv[1];
    if (!selector) return fail('usage: dom --url <local-url> act click "<selector>"', 2);
    const matched = $(selector).length;
    if (!matched) return fail(`act click: selector not found (${selector})`, 4);
    return ok(JSON.stringify({ cmd: 'act click', selector, matched, ok: true }, null, 0));
  }

  if (op === 'type') {
    const selector = argv[1];
    const text = argv[2] ?? '';
    if (!selector || argv.length < 3) return fail('usage: dom --url <local-url> act type "<selector>" "<text>"', 2);
    const matched = $(selector).length;
    if (!matched) return fail(`act type: selector not found (${selector})`, 4);
    return ok(JSON.stringify({ cmd: 'act type', selector, matched, text: compactText(text, MAX_TEXT), ok: true }, null, 0));
  }

  if (op === 'select') {
    const selector = argv[1];
    const value = argv[2] ?? '';
    if (!selector || argv.length < 3) return fail('usage: dom --url <local-url> act select "<selector>" "<value>"', 2);
    const matched = $(selector).length;
    if (!matched) return fail(`act select: selector not found (${selector})`, 4);
    return ok(JSON.stringify({ cmd: 'act select', selector, matched, value: compactText(value, MAX_TEXT), ok: true }, null, 0));
  }

  if (op === 'press') {
    const key = argv[1];
    if (!key) return fail('usage: dom --url <local-url> act press "<key>"', 2);
    return ok(JSON.stringify({ cmd: 'act press', key, ok: true }, null, 0));
  }

  if (op === 'snapshot') {
    const schema = readFlag(argv, '--schema', 'compact');
    if (schema !== 'compact') return fail('only --schema compact is supported', 2);
    return ok(snapshotCompact($, 'act snapshot'));
  }

  return fail('unknown dom act command. Try: dom --help', 2);
}

function snapshotCompact($, cmd) {
  const title = compactText($('title').first().text(), MAX_TEXT);
  const links = $('a[href]').length;
  const forms = $('form').length;
  const headings = ['h1', 'h2', 'h3'].map((h) => compactText($(h).first().text(), MAX_TEXT)).filter(Boolean);
  const bodyText = compactText($('body').text(), 500);
  return JSON.stringify({ cmd, schema: 'compact', title, counts: { links, forms }, headings, bodyText }, null, 0);
}

function isAllowedLocalUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'home.local' || host.endsWith('.local')) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 169 && b === 254) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function parseSource(argv) {
  const url = readFlag(argv, '--url');
  const file = readFlag(argv, '--file');
  const rest = stripFlag(argv, '--url', url ? 1 : 0);
  const rest2 = stripFlag(rest, '--file', file ? 1 : 0);
  return { source: { url, file }, rest: rest2 };
}

async function loadHtml(source, cfg) {
  if (source.file) {
    const p = resolve(cfg.cwd || process.cwd(), source.file);
    return await readFile(p, 'utf8');
  }
  const url = source.url || 'https://example.com';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return await res.text();
}

function readFlag(argv, name, dflt = undefined) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  return argv[i + 1] ?? dflt;
}

function stripFlag(argv, name, hasValue) {
  const i = argv.indexOf(name);
  if (i < 0) return argv;
  const n = hasValue ? 2 : 1;
  return [...argv.slice(0, i), ...argv.slice(i + n)];
}

function compactText(s, max = MAX_TEXT) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function isEqualPrimitive(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function depthOf(el) {
  let d = 0;
  let cur = el;
  while (cur?.parent) {
    d += 1;
    cur = cur.parent;
  }
  return d;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

function ok(output) {
  return { exitCode: 0, stdout: Buffer.from(`${output}\n`), stderr: Buffer.alloc(0) };
}

function fail(msg, code = 1) {
  return { exitCode: code, stdout: Buffer.alloc(0), stderr: Buffer.from(`[error] ${msg}\n`) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helpText() {
  return [
    'DOM harness (read + local act mode)',
    'usage:',
    '  dom [--url URL|--file FILE] query "<selector>" [--top N] [--text]',
    '  dom [--url URL|--file FILE] pick "<selector>" --fields "name:sel,name2:sel@attr" [--top N] [--jsonl]',
    '  dom [--url URL|--file FILE] near "<needle text>" --within "form,section" --return "input@name,input@value"',
    '  dom diff [left.json right.json]',
    '  dom diff --left left.json --right right.json',
    '  cat pair.json | dom diff',
    '  dom [--url URL|--file FILE] find-text "<text>" [--context N]',
    '  dom [--url URL|--file FILE] extract links [--contains X]',
    '  dom [--url URL|--file FILE] snapshot --schema compact',
    '  dom --url <local-url> act click "<selector>"',
    '  dom --url <local-url> act type "<selector>" "<text>"',
    '  dom --url <local-url> act select "<selector>" "<value>"',
    '  dom --url <local-url> act press "<key>"',
    '  dom --url <local-url> act wait-text "<text>" [--timeout-ms N]',
    '  dom --url <local-url> act snapshot --schema compact'
  ].join('\n');
}
