import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';

const MAX_TEXT = 200;

export async function runDomCli(argv, cfg = {}) {
  const enabled = String(process.env.HARNESS_DOM_ENABLED ?? cfg.domEnabled ?? '1') === '1';
  if (!enabled) {
    return fail('dom harness disabled (HARNESS_DOM_ENABLED=0)', 3);
  }

  if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') {
    return ok(helpText());
  }

  const { source, rest } = parseSource(argv);
  const cmd = rest[0];
  if (!cmd) return fail('missing dom subcommand. Try: dom --help', 2);

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
    const title = compactText($('title').first().text(), MAX_TEXT);
    const links = $('a[href]').length;
    const forms = $('form').length;
    const headings = ['h1', 'h2', 'h3'].map((h) => compactText($(h).first().text(), MAX_TEXT)).filter(Boolean);
    const bodyText = compactText($('body').text(), 500);
    return ok(JSON.stringify({ cmd: 'snapshot', schema: 'compact', title, counts: { links, forms }, headings, bodyText }, null, 0));
  }

  return fail('unknown dom subcommand. Try: dom --help', 2);
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

function helpText() {
  return [
    'DOM harness (read-mode)',
    'usage:',
    '  dom [--url URL|--file FILE] query "<selector>" [--top N] [--text]',
    '  dom [--url URL|--file FILE] find-text "<text>" [--context N]',
    '  dom [--url URL|--file FILE] extract links [--contains X]',
    '  dom [--url URL|--file FILE] snapshot --schema compact'
  ].join('\n');
}
