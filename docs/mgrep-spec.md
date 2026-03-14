# mgrep Specification (v2)

## Purpose
`mgrep` is a local-first, Unix-native semantic grep command. It returns grep-like lines ranked by semantic relevance while preserving line-oriented shell behavior.

v2 adds persistent indexing so repeated semantic queries are significantly faster on the same target paths.

## CLI Contract

### Query forms
- `mgrep [flags] "query" <file...|dir...>` (backward-compatible default)
- `mgrep query [flags] "query" <file...|dir...>`
- `mgrep -r [flags] "query" <dir...>`
- `cat file.txt | mgrep [flags] "query"`

### Index forms
- `mgrep index <path>` build/update persistent index
- `mgrep index --status <path>` show cache metadata/freshness
- `mgrep index --clear <path>` remove cache entry for target

### Query flags
- `-r, --recursive` recurse directories
- `-k, --top-k N` maximum printed matches (default `20`)
- `-t, --threshold F` score floor in `[0,1]` (default `0.25`)
- `-n, --max-lines N` max lines scanned per input stream (default `20000`)
- `--cache-ttl-sec N` max cache age before bypassing index (`86400`; `0` means always bypass cache)
- `-h, --help` usage text

### Index flags
- `--max-files N` cap files indexed per target (default `2000`)
- `--chunk-lines N` lines per index chunk (default `20`)
- `--cache-ttl-sec N` freshness threshold for `--status`
- `--status`, `--clear`, `-h`, `--help`

### Environment knobs
- `HARNESS_ROOT`: index location root (`$HARNESS_ROOT/.mgrep-index`)
- `MGREP_INDEX_MAX_FILES`: default index max files
- `MGREP_CHUNK_LINES`: default index chunk size
- `MGREP_CACHE_TTL_SEC`: default cache TTL

### Output
One match per line:
- `file:line:score:snippet`
- stdin mode uses `stdin:line:score:snippet`
- score is fixed-point `[0,1]` with 3 decimals.

### Exit Codes
- `0` at least one match printed / successful index operation
- `1` no matches / index missing on `--status`
- `2` invalid args/runtime usage error

## Persistent Index Design

### Storage
- Per-target index JSON stored under `.mgrep-index/` in harness root.
- Keyed by sha1 of absolute target path.
- Query mode is read-only to source targets.
- Index writes only occur inside `.mgrep-index/`.

### Incremental updates
Each indexed file tracks:
- `mtimeMs`
- `size`
- `hash` (sha1)
- chunked line payload

Update strategy:
1. Fast unchanged check via `(mtime,size)`.
2. If changed, recompute hash and reuse previous content if hash unchanged.
3. Reindex only changed/new files.
4. Remove deleted files from index.

## Ranking

### Base deterministic lexical+semantic-lite score
Score is bounded to `[0,1]`, combining:
- token overlap Jaccard (0.45)
- trigram similarity (0.30)
- exact phrase containment bonus (0.20)
- token-prefix bonus (0.05)

### Indexed query behavior
When a fresh target index exists (single target only), query runs from index chunks/lines and avoids rescanning files.
If index is missing or stale, mgrep falls back to direct scan gracefully.

### Optional embedding rerank (local)
If `MGREP_EMBED_ENDPOINT` is set, mgrep attempts local OpenAI-compatible `/v1/embeddings` rerank on top candidates (`<=200`). On failure, it silently falls back to deterministic lexical ranking.

Final rerank blend per candidate:
- `0.65 * lexical + 0.35 * cosine(embedding)`

## Safety + Policy
- Query path semantics are read-only.
- Indexing writes only under `.mgrep-index/`.
- No external APIs required.
- If embedding endpoint unavailable, behavior remains functional.

## Performance Notes
- First query (without index): stream and score file lines.
- Indexed path queries: avoid file I/O rescans, typically much faster on repeated searches.
- Tune `--chunk-lines` and `--max-files` for large trees.
- Use TTL (`--cache-ttl-sec`) for cache invalidation policy.
