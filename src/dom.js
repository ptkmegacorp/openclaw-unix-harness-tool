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

  if (cmd === 'act') {
    return runAct(rest.slice(1), source, cfg);
  }

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
