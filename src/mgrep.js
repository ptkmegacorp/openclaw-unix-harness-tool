import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_TOP_K = 20;
const DEFAULT_THRESHOLD = 0.25;
const DEFAULT_MAX_LINES = 20000;
const DEFAULT_INDEX_MAX_FILES = 2000;
const DEFAULT_CHUNK_LINES = 20;
const DEFAULT_CACHE_TTL_SEC = 86400;
const MAX_CANDIDATES_FOR_EMBED = 200;

export async function main(argv = process.argv.slice(2), io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }) {
  const parsed = parseCli(argv, io.env);
  if (parsed.help) {
    io.stdout.write(usage());
    return 0;
  }
  if (parsed.error) {
    io.stderr.write(`${parsed.error}\n\n${usage()}`);
    return 2;
  }

  if (parsed.mode === 'index') {
    return runIndex(parsed, io);
  }

  return runQuery(parsed, io);
}

function parseCli(argv, env) {
  if (!argv.length) return { mode: 'query', ...parseQueryArgs([], env) };
  if (argv[0] === 'index') return { mode: 'index', ...parseIndexArgs(argv.slice(1), env) };
  if (argv[0] === 'query') return { mode: 'query', ...parseQueryArgs(argv.slice(1), env) };
  return { mode: 'query', ...parseQueryArgs(argv, env) };
}

function parseQueryArgs(argv, env) {
  const out = {
    recursive: false,
    topK: DEFAULT_TOP_K,
    threshold: DEFAULT_THRESHOLD,
    maxLines: DEFAULT_MAX_LINES,
    cacheTtlSec: intFromEnv(env, 'MGREP_CACHE_TTL_SEC', DEFAULT_CACHE_TTL_SEC),
    help: false,
    query: '',
    targets: [],
    error: ''
  };

  const args = [...argv];
  while (args.length) {
    const a = args[0];
    if (a === '--') {
      args.shift();
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    args.shift();
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-r' || a === '--recursive') out.recursive = true;
    else if (a === '-k' || a === '--top-k') {
      const v = args.shift();
      if (!isPosInt(v)) return { ...out, error: `[error] invalid top-k: ${v || ''}` };
      out.topK = Number(v);
    } else if (a === '-t' || a === '--threshold') {
      const v = args.shift();
      const n = Number(v);
      if (v == null || Number.isNaN(n) || n < 0 || n > 1) return { ...out, error: `[error] invalid threshold: ${v || ''}` };
      out.threshold = n;
    } else if (a === '-n' || a === '--max-lines') {
      const v = args.shift();
      if (!isPosInt(v)) return { ...out, error: `[error] invalid max-lines: ${v || ''}` };
      out.maxLines = Number(v);
    } else if (a === '--cache-ttl-sec') {
      const v = args.shift();
      if (!isNonNegInt(v)) return { ...out, error: `[error] invalid cache-ttl-sec: ${v || ''}` };
      out.cacheTtlSec = Number(v);
    } else {
      return { ...out, error: `[error] unknown flag: ${a}` };
    }
  }

  if (out.help) return out;
  if (!args.length) return { ...out, error: `[error] missing query` };
  out.query = args.shift();
  out.targets = args;
  return out;
}

function parseIndexArgs(argv, env) {
  const out = {
    help: false,
    status: false,
    clear: false,
    path: '',
    maxFiles: intFromEnv(env, 'MGREP_INDEX_MAX_FILES', DEFAULT_INDEX_MAX_FILES),
    chunkLines: intFromEnv(env, 'MGREP_CHUNK_LINES', DEFAULT_CHUNK_LINES),
    cacheTtlSec: intFromEnv(env, 'MGREP_CACHE_TTL_SEC', DEFAULT_CACHE_TTL_SEC),
    error: ''
  };

  const args = [...argv];
  while (args.length) {
    const a = args[0];
    if (!a.startsWith('-') || a === '-') break;
    args.shift();
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--status') out.status = true;
    else if (a === '--clear') out.clear = true;
    else if (a === '--max-files') {
      const v = args.shift();
      if (!isPosInt(v)) return { ...out, error: `[error] invalid max-files: ${v || ''}` };
      out.maxFiles = Number(v);
    } else if (a === '--chunk-lines') {
      const v = args.shift();
      if (!isPosInt(v)) return { ...out, error: `[error] invalid chunk-lines: ${v || ''}` };
      out.chunkLines = Number(v);
    } else if (a === '--cache-ttl-sec') {
      const v = args.shift();
      if (!isNonNegInt(v)) return { ...out, error: `[error] invalid cache-ttl-sec: ${v || ''}` };
      out.cacheTtlSec = Number(v);
    } else {
      return { ...out, error: `[error] unknown flag: ${a}` };
    }
  }

  if (out.help) return out;
  if (!args.length) return { ...out, error: `[error] missing path` };
  out.path = args.shift();
  if (args.length) return { ...out, error: `[error] unexpected argument: ${args[0]}` };
  if (out.clear && out.status) return { ...out, error: '[error] --status and --clear cannot be used together' };
  return out;
}

async function runQuery(parsed, io) {
  const queryTokens = tokenize(parsed.query);
  if (!queryTokens.length) {
    io.stderr.write('[error] query must contain searchable text\n');
    return 2;
  }

  let ranked = [];
  let usedIndex = false;
  let sourceMode = 'scan';

  if (parsed.targets.length > 0) {
    const idx = await tryQueryWithIndex(parsed, queryTokens, io.env);
    if (idx) {
      ranked = idx.matches;
      usedIndex = true;
      sourceMode = idx.mode;
    } else {
      const sources = await collectTargetFiles(parsed.targets, parsed.recursive);
      ranked = await scanSources(sources, parsed, queryTokens, io);
    }
  } else if (!io.stdin.isTTY) {
    ranked = await scanSources([{ type: 'stdin' }], parsed, queryTokens, io);
  } else {
    io.stderr.write(`[error] missing search target (file/dir/glob) or stdin\n\n${usage()}`);
    return 2;
  }

  const embedEndpoint = io.env.MGREP_EMBED_ENDPOINT || '';
  const embedModel = io.env.MGREP_EMBED_MODEL || 'nomic-embed-text';
  if (embedEndpoint && ranked.length > 0) {
    ranked = await rerankWithEmbeddings(ranked, parsed.query, embedEndpoint, embedModel);
  }

  const top = ranked.slice(0, parsed.topK);
  for (const m of top) {
    io.stdout.write(`${m.file}:${m.line}:${m.score.toFixed(3)}:${m.snippet}\n`);
  }
  if (usedIndex && sourceMode === 'index') {
    io.stderr.write('[mgrep] using cached index\n');
  }
  return top.length ? 0 : 1;
}

async function runIndex(parsed, io) {
  const targetPath = path.resolve(parsed.path);
  const indexStore = getIndexStorePath(io.env);

  if (parsed.clear) {
    const key = targetKey(targetPath);
    const file = path.join(indexStore, `${key}.json`);
    await fs.rm(file, { force: true });
    io.stdout.write(`cleared index for ${targetPath}\n`);
    return 0;
  }

  if (parsed.status) {
    const stat = await readIndexStatus(targetPath, io.env, parsed.cacheTtlSec);
    if (!stat.exists) {
      io.stdout.write(`index: missing\ntarget: ${targetPath}\n`);
      return 1;
    }
    io.stdout.write(`index: present\ntarget: ${targetPath}\nfiles: ${stat.files}\nchunks: ${stat.chunks}\nupdated: ${stat.updatedAt}\nage_sec: ${stat.ageSec}\nfresh: ${stat.fresh ? 'yes' : 'no'}\n`);
    return 0;
  }

  const result = await buildOrUpdateIndex(targetPath, {
    maxFiles: parsed.maxFiles,
    chunkLines: parsed.chunkLines,
    indexStore
  });

  io.stdout.write(`indexed ${result.filesIndexed} files (${result.filesAdded} added, ${result.filesUpdated} updated, ${result.filesUnchanged} unchanged, ${result.filesRemoved} removed), chunks=${result.chunkCount}\n`);
  if (result.limited) io.stdout.write(`[warn] max-files limit reached (${parsed.maxFiles})\n`);
  return 0;
}

async function tryQueryWithIndex(parsed, queryTokens, env) {
  if (parsed.targets.length !== 1) return null;
  const targetPath = path.resolve(parsed.targets[0]);
  const status = await readIndexStatus(targetPath, env, parsed.cacheTtlSec);
  if (!status.exists || !status.fresh) return null;

  const indexFile = path.join(getIndexStorePath(env), `${targetKey(targetPath)}.json`);
  const data = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  const rows = [];

  for (const fe of data.files) {
    for (const chunk of fe.chunks) {
      const chunkScore = lexicalScore(parsed.query, queryTokens, chunk.text);
      if (chunkScore < parsed.threshold * 0.7) continue;
      for (const line of chunk.lines) {
        const score = lexicalScore(parsed.query, queryTokens, line.t);
        if (score >= parsed.threshold) {
          rows.push({
            file: fe.relPath,
            line: line.n,
            score,
            snippet: sanitizeSnippet(line.t),
            stableKey: stableId(fe.relPath, line.n, line.t)
          });
        }
      }
    }
  }

  return { matches: rows.sort(sortByScoreThenStable), mode: 'index' };
}

async function scanSources(sources, parsed, queryTokens, io) {
  const lexicalMatches = [];
  for (const src of sources) {
    const rows = src.type === 'stdin'
      ? await scanStdin(io.stdin, parsed.query, queryTokens, parsed.maxLines)
      : await scanFile(src.path, parsed.query, queryTokens, parsed.maxLines);
    for (const row of rows) {
      if (row.score >= parsed.threshold) lexicalMatches.push(row);
    }
  }
  return lexicalMatches.sort(sortByScoreThenStable);
}

function getIndexStorePath(env) {
  const root = env.HARNESS_ROOT || process.cwd();
  return path.join(root, '.mgrep-index');
}

function targetKey(absTargetPath) {
  return createHash('sha1').update(absTargetPath).digest('hex');
}

async function readIndexStatus(absTargetPath, env, ttlSec) {
  const store = getIndexStorePath(env);
  const key = targetKey(absTargetPath);
  const file = path.join(store, `${key}.json`);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    const ageSec = Math.max(0, Math.floor((Date.now() - new Date(data.updatedAt).getTime()) / 1000));
    const fresh = ttlSec === 0 ? false : ageSec <= ttlSec;
    return {
      exists: true,
      files: data.files.length,
      chunks: data.files.reduce((n, f) => n + f.chunks.length, 0),
      updatedAt: data.updatedAt,
      ageSec,
      fresh
    };
  } catch {
    return { exists: false, files: 0, chunks: 0, updatedAt: '', ageSec: 0, fresh: false };
  }
}

async function buildOrUpdateIndex(absTargetPath, opts) {
  await fs.mkdir(opts.indexStore, { recursive: true });
  const key = targetKey(absTargetPath);
  const idxPath = path.join(opts.indexStore, `${key}.json`);

  const previous = await readJsonSafe(idxPath);
  const prevMap = new Map((previous?.files || []).map((f) => [f.relPath, f]));

  const targetFiles = await collectIndexFiles(absTargetPath, opts.maxFiles);
  const newFiles = [];
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesUnchanged = 0;
  let chunkCount = 0;

  for (const tf of targetFiles.files) {
    const prev = prevMap.get(tf.relPath);
    const fastMatch = prev && prev.mtimeMs === tf.mtimeMs && prev.size === tf.size;
    if (fastMatch) {
      newFiles.push(prev);
      filesUnchanged += 1;
      chunkCount += prev.chunks.length;
      continue;
    }

    const hash = await hashFile(tf.absPath);
    if (prev && prev.hash === hash) {
      prev.mtimeMs = tf.mtimeMs;
      prev.size = tf.size;
      newFiles.push(prev);
      filesUnchanged += 1;
      chunkCount += prev.chunks.length;
      continue;
    }

    const indexed = await indexFile(tf.absPath, tf.relPath, tf.mtimeMs, tf.size, hash, opts.chunkLines);
    newFiles.push(indexed);
    chunkCount += indexed.chunks.length;
    if (prev) filesUpdated += 1;
    else filesAdded += 1;
  }

  const nextRel = new Set(newFiles.map((f) => f.relPath));
  const filesRemoved = [...prevMap.keys()].filter((p) => !nextRel.has(p)).length;

  const payload = {
    version: 1,
    targetPath: absTargetPath,
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      maxFiles: opts.maxFiles,
      chunkLines: opts.chunkLines
    },
    files: newFiles
  };

  await fs.writeFile(idxPath, JSON.stringify(payload), 'utf8');
  return {
    filesIndexed: newFiles.length,
    filesAdded,
    filesUpdated,
    filesUnchanged,
    filesRemoved,
    chunkCount,
    limited: targetFiles.limited
  };
}

async function collectIndexFiles(targetPath, maxFiles) {
  const st = await fs.stat(targetPath);
  if (st.isFile()) {
    return {
      files: [{ absPath: targetPath, relPath: path.basename(targetPath), mtimeMs: st.mtimeMs, size: st.size }],
      limited: false
    };
  }

  const files = [];
  let limited = false;
  async function walk(dir, base) {
    if (files.length >= maxFiles) {
      limited = true;
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(base, p) || e.name;
      if (e.isDirectory()) {
        await walk(p, base);
        if (files.length >= maxFiles) {
          limited = true;
          return;
        }
      } else if (e.isFile()) {
        const fst = await fs.stat(p);
        files.push({ absPath: p, relPath: rel, mtimeMs: fst.mtimeMs, size: fst.size });
        if (files.length >= maxFiles) {
          limited = true;
          return;
        }
      }
    }
  }

  await walk(targetPath, targetPath);
  return { files, limited };
}

async function indexFile(absPath, relPath, mtimeMs, size, hash, chunkLines) {
  const rs = createReadStream(absPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
  const chunks = [];
  let bucket = [];
  let startLine = 1;
  let lineNo = 0;

  for await (const lineRaw of rl) {
    lineNo += 1;
    const text = String(lineRaw);
    if (bucket.length === 0) startLine = lineNo;
    bucket.push({ n: lineNo, t: text });
    if (bucket.length >= chunkLines) {
      chunks.push(makeChunk(bucket, startLine));
      bucket = [];
    }
  }
  if (bucket.length) chunks.push(makeChunk(bucket, startLine));

  return { relPath, mtimeMs, size, hash, chunks };
}

function makeChunk(lines, lineStart) {
  return {
    lineStart,
    text: lines.map((l) => l.t).join(' '),
    lines
  };
}

async function hashFile(filePath) {
  const hash = createHash('sha1');
  const rs = createReadStream(filePath);
  return await new Promise((resolve, reject) => {
    rs.on('data', (d) => hash.update(d));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function collectTargetFiles(targets, recursive) {
  const files = [];
  for (const t of targets) {
    try {
      const st = await fs.stat(t);
      if (st.isDirectory()) {
        if (!recursive) continue;
        await walkDir(t, files);
      } else if (st.isFile()) {
        files.push({ type: 'file', path: t });
      }
    } catch {
      // ignore missing targets
    }
  }
  return files;
}

async function walkDir(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkDir(p, out);
    else if (e.isFile()) out.push({ type: 'file', path: p });
  }
}

async function scanFile(filePath, query, queryTokens, maxLines) {
  const rs = createReadStream(filePath, { encoding: 'utf8' });
  return scanLineStream(rs, filePath, query, queryTokens, maxLines);
}

async function scanStdin(stdin, query, queryTokens, maxLines) {
  return scanLineStream(stdin, 'stdin', query, queryTokens, maxLines);
}

async function scanLineStream(stream, fileLabel, query, queryTokens, maxLines) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out = [];
  let lineNo = 0;
  for await (const lineRaw of rl) {
    lineNo += 1;
    if (lineNo > maxLines) break;
    const line = String(lineRaw);
    const score = lexicalScore(query, queryTokens, line);
    if (score > 0) {
      out.push({
        file: fileLabel,
        line: lineNo,
        score,
        snippet: sanitizeSnippet(line),
        stableKey: stableId(fileLabel, lineNo, line)
      });
    }
  }
  return out;
}

function lexicalScore(query, queryTokens, line) {
  const lineLower = line.toLowerCase();
  const lineTokens = tokenize(lineLower);
  if (!lineTokens.length) return 0;

  const qSet = new Set(queryTokens);
  const lSet = new Set(lineTokens);

  let overlap = 0;
  for (const t of qSet) if (lSet.has(t)) overlap += 1;
  const denom = qSet.size + lSet.size - overlap;
  const jaccard = denom ? overlap / denom : 0;

  const phrase = lineLower.includes(query.toLowerCase()) ? 1 : 0;
  const prefix = queryTokens.some((t) => lineTokens.some((lt) => lt.startsWith(t))) ? 1 : 0;
  const trigram = trigramSimilarity(query.toLowerCase(), lineLower);

  const score = 0.45 * jaccard + 0.3 * trigram + 0.2 * phrase + 0.05 * prefix;
  return Math.max(0, Math.min(1, score));
}

function trigramSimilarity(a, b) {
  const ta = grams(a, 3);
  const tb = grams(b, 3);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter += 1;
  return inter / Math.sqrt(ta.size * tb.size);
}

function grams(str, n) {
  const norm = str.replace(/\s+/g, ' ').trim();
  const set = new Set();
  if (norm.length < n) return set;
  for (let i = 0; i <= norm.length - n; i++) set.add(norm.slice(i, i + n));
  return set;
}

function tokenize(s) {
  return s.toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function sanitizeSnippet(s) {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function stableId(file, line, content) {
  return createHash('sha1').update(`${file}:${line}:${content}`).digest('hex').slice(0, 12);
}

function sortByScoreThenStable(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return a.line - b.line;
}

async function rerankWithEmbeddings(matches, query, endpoint, model) {
  try {
    const candidates = matches.slice(0, MAX_CANDIDATES_FOR_EMBED);
    const texts = [query, ...candidates.map((m) => m.snippet)];
    const vecs = await fetchEmbeddings(endpoint, model, texts);
    if (!vecs || vecs.length !== texts.length) return matches;
    const q = vecs[0];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const sem = cosine(q, vecs[i + 1]);
      c.score = Math.max(0, Math.min(1, 0.65 * c.score + 0.35 * sem));
    }
    return [...candidates, ...matches.slice(MAX_CANDIDATES_FOR_EMBED)].sort(sortByScoreThenStable);
  } catch {
    return matches;
  }
}

async function fetchEmbeddings(endpoint, model, input) {
  const u = endpoint.endsWith('/') ? `${endpoint}v1/embeddings` : `${endpoint}/v1/embeddings`;
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input })
  });
  if (!res.ok) throw new Error(`embed http ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error('bad embed response');
  return body.data.map((d) => d.embedding);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function intFromEnv(env, key, fallback) {
  const raw = env[key];
  if (raw == null || raw === '') return fallback;
  return /^\d+$/.test(raw) ? Number(raw) : fallback;
}

function isPosInt(v) {
  return !!v && /^\d+$/.test(v) && Number(v) > 0;
}

function isNonNegInt(v) {
  return !!v && /^\d+$/.test(v);
}

function usage() {
  return `mgrep - semantic grep (local-first)\n\nUsage:\n  mgrep [flags] \"query\" <file...|dir...>\n  mgrep query [flags] \"query\" <file...|dir...>\n  mgrep -r [flags] \"query\" <dir...>\n  cat file.txt | mgrep [flags] \"query\"\n\n  mgrep index [flags] <path>\n  mgrep index --status <path>\n  mgrep index --clear <path>\n\nQuery flags:\n  -r, --recursive         Recurse into directories\n  -k, --top-k N           Max results to print (default: ${DEFAULT_TOP_K})\n  -t, --threshold F       Minimum score 0..1 (default: ${DEFAULT_THRESHOLD})\n  -n, --max-lines N       Max lines read per input stream (default: ${DEFAULT_MAX_LINES})\n      --cache-ttl-sec N   Max index age before fallback scan (default: ${DEFAULT_CACHE_TTL_SEC}, 0=always bypass cache)\n  -h, --help              Show help\n\nIndex flags:\n      --max-files N       Max files indexed (default: ${DEFAULT_INDEX_MAX_FILES})\n      --chunk-lines N     Lines per index chunk (default: ${DEFAULT_CHUNK_LINES})\n      --cache-ttl-sec N   Status freshness threshold (default: ${DEFAULT_CACHE_TTL_SEC})\n      --status            Show index status\n      --clear             Remove persisted index for target\n  -h, --help              Show help\n\nEnv config:\n  HARNESS_ROOT            Harness root (index stored at $HARNESS_ROOT/.mgrep-index)\n  MGREP_INDEX_MAX_FILES   Default --max-files\n  MGREP_CHUNK_LINES       Default --chunk-lines\n  MGREP_CACHE_TTL_SEC     Default --cache-ttl-sec\n\nOutput format:\n  file:line:score:snippet\n\nExit codes:\n  0 matches found / successful index op\n  1 no matches or missing index on --status\n  2 usage/argument error\n`;}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`[error] ${String(err?.message || err)}\n`);
    process.exit(2);
  });
}
