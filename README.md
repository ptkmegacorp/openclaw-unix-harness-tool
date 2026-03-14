# local-unix-harness v1

Unix-native single-surface harness implementing `run(command)` with robust operator parsing, safety gates, JSONL tracing, overflow artifacts, and optional local llama.cpp (OpenAI-compatible) presentation.

## Features

- **Modules**: parser / executor / presenter / policy / trace / server
- **Operators**: `|`, `&&`, `||`, `;` with quote-aware chain parsing
- **Two-layer architecture**:
  - Layer 1: raw execution (stdout/stderr/exit semantics)
  - Layer 2: LLM-facing presentation (binary guard, truncation, stderr display, footer)
- **Safety classes**:
  - A: read-only allowed
  - B: reversible/audited writes
  - C: destructive/external blocked unless explicit confirm flags
- **Budget guards**: max segments, timeout, response caps
- **Overflow mode**: truncates model-facing output, writes full artifact file
- **Trace**: JSONL rows in `logs/run-trace.jsonl`
- **HTTP API**: `POST /run { command }`
- **LLM adapter**: local endpoints health + optional formatting pass via OpenAI-compatible API

## Install

```bash
cd /home/bot/local-ai-harness
npm install
```

## Run server

```bash
npm start
# listens on :8787 by default
```

### API

`POST /run`

```json
{
  "command": "echo a | wc -c",
  "confirm": {
    "delete": false,
    "external": false
  }
}
```

Response:

```json
{
  "ok": true,
  "exitCode": 0,
  "output": "2\n[exit:0 | 5ms]",
  "artifactPath": null,
  "truncated": false
}
```

Health:

```bash
curl -s localhost:8787/health
```

## CLI

```bash
npm run cli -- run "echo hello"
npm run cli -- health
```

For guarded commands:

```bash
npm run cli -- run "rm -rf /tmp/x" --confirm-delete
npm run cli -- run "curl https://example.com" --confirm-external
```

## Local llama.cpp config

Uses OpenAI-compatible endpoints (default):
- `http://127.0.0.1:8080`
- `http://127.0.0.1:8081`

Environment:

```bash
export HARNESS_USE_LLM_PRESENTER=1
export HARNESS_LLM_MODEL="your-local-model"
export HARNESS_LLM_ENDPOINTS="http://127.0.0.1:8080,http://127.0.0.1:8081"
```

## Tests

```bash
npm test
```

Covers v1 matrix areas:
- Unix semantics integrity
- Layer separation
- Overflow behavior + artifact
- Binary guard
- stderr policy
- Safety classes and confirmation gates
- Budget controls
- Trace logging
- Recovery UX checks
- mgrep semantic search (file / recursive / stdin / flags)

## mgrep semantic grep (+ persistent index)

`mgrep` is a local-first "grep for meaning" command available inside `run(command)`.

Examples:

```bash
# direct files (backward-compatible query mode)
npm run cli -- run 'mgrep "database connection error" app.log notes.txt'

# explicit query subcommand
npm run cli -- run 'mgrep query "database connection error" app.log notes.txt'

# recursive search
npm run cli -- run 'mgrep -r -k 10 -t 0.35 "retry backoff" ./src'

# build/update index cache
npm run cli -- run 'mgrep index ./src'

# inspect / clear index
npm run cli -- run 'mgrep index --status ./src'
npm run cli -- run 'mgrep index --clear ./src'

# pipeline mode
npm run cli -- run 'cat app.log | mgrep -k 5 "timeout while connecting"'
```

Output is grep-like and pipe-safe:

```text
file:line:score:snippet
```

Index details:
- Persistent cache directory: `$HARNESS_ROOT/.mgrep-index/`
- Incremental updates use mtime/size/hash checks
- Query path stays read-only; index writes only to index dir
- Config knobs: `--max-files`, `--chunk-lines`, `--cache-ttl-sec` (or env defaults)

Performance note: first query on an unindexed target does full scan; repeated queries against a fresh index are significantly faster.

Troubleshooting:
- No results: lower `-t` threshold (e.g. `-t 0.15`)
- Too many results: lower `-k` and/or raise `-t`
- Need deeper local semantics: set `MGREP_EMBED_ENDPOINT=http://127.0.0.1:8080` (OpenAI-compatible embeddings)
- Behavior is deterministic even when embeddings are unavailable

## File layout

- `src/parser.js`
- `src/executor.js`
- `src/presenter.js`
- `src/policy.js`
- `src/trace.js`
- `src/run.js`
- `src/server.js`
- `src/cli.js`
- `src/mgrep.js`
- `bin/mgrep`
- `test/harness.test.js`


## Local-model-first profile
- Defaults to local llama.cpp OpenAI-compatible endpoints (`127.0.0.1:8080,8081`).
- `HARNESS_USE_LLM_PRESENTER=1` by default in plugin wiring.
- Keep commands short, deterministic, and pipe-friendly for small local models.
