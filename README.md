# local-unix-harness v1

Unix-native single-surface harness implementing `run(command)` with robust operator parsing, safety gates, JSONL tracing, overflow artifacts, and optional local llama.cpp (OpenAI-compatible) presentation.

## Features

- **Modules**: parser / executor / backends(manager/native/sandbox) / presenter / policy / trace / server
- **Operators**: `|`, `&&`, `||`, `;` with quote-aware chain parsing
- **Two-layer architecture**:
  - Layer 1: raw execution (stdout/stderr/exit semantics) via backend manager
    - NativeBackend: typed in-process handlers for simple read-only commands (no host shell)
    - SandboxBackend: concrete isolated runtime selector with preference order:
      1. boxlite
      2. docker/podman container sandbox
      3. hard unavailable error (no host-shell fallback for class B/C)
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

## Backend routing policy

- Class **A** (read-only): prefers `NativeBackend` when command shape is supported safely (no shell metacharacters).
- Class **B/C**: always routed to `SandboxBackend`.
- If no sandbox runtime is available, class **B/C** returns deterministic error:
  - `[error] sandbox backend unavailable: no supported runtime detected (boxlite, docker, podman)...`
- Class **C** still requires explicit confirm gates (`confirmDelete`, `confirmExternalSend`) before any execution.

This keeps compatibility with existing `run(command)` semantics while introducing a clean backend boundary.

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

Now returns both LLM and sandbox backend status (provider, runtime availability, init errors).

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

## Sandbox runtime requirements

At least one sandbox runtime must be installed for class B/C commands:

- Preferred: `boxlite`
- Fallback: `docker` or `podman`

Selection order is automatic (`boxlite` -> `docker/podman`).
Optional overrides:

- `HARNESS_SANDBOX_PROVIDER=auto|boxlite|docker|podman`
- `HARNESS_SANDBOX_IMAGE=<image>` (container backend, default `debian:bookworm-slim`)

Isolation model (container/box runtime):
- No host root filesystem mount
- Bound mount only for working directory at `/workspace`
- `--network none`, dropped capabilities, no-new-privileges
- Timeout enforced by harness with exit code `124`

Known limits:
- Runtime/image startup latency affects first command
- Container image must include `sh` and tools needed by executed commands

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
- dom harness extraction commands + toggle behavior

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
- `src/backends/backend.js`
- `src/backends/manager.js`
- `src/backends/native.js`
- `src/backends/sandbox.js`
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

## dom harness (optional HTML/JS DOM read plugin)

Enable/disable:

```bash
export HARNESS_DOM_ENABLED=1   # default
export HARNESS_DOM_ENABLED=0   # deterministic disabled error
```

Examples:

```bash
npm run cli -- run 'dom --url https://example.com query "a" --top 5 --text'
npm run cli -- run 'dom --file ./page.html find-text "pricing" --context 60'
npm run cli -- run 'dom --url https://example.com extract links --contains docs'
npm run cli -- run 'dom --url https://example.com snapshot --schema compact'
```

Spec: `docs/dom-harness-spec.md`.


### DOM Act mode (local-only)

Environment toggles:
```bash
export HARNESS_DOM_ENABLED=1      # default
export HARNESS_DOM_ACT_ENABLED=0  # default (disabled)
export HARNESS_DOM_ACT_ENABLED=1  # enable act mode
```

Act commands:
```bash
npm run cli -- run 'dom --url http://127.0.0.1:3000 act click "#submit"'
npm run cli -- run 'dom --url http://127.0.0.1:3000 act type "#q" "hello"'
npm run cli -- run 'dom --url http://127.0.0.1:3000 act select "#plan" "pro"'
npm run cli -- run 'dom --url http://127.0.0.1:3000 act press "Enter"'
npm run cli -- run 'dom --url http://127.0.0.1:3000 act wait-text "ready" --timeout-ms 5000'
npm run cli -- run 'dom --url http://127.0.0.1:3000 act snapshot --schema compact'
```

Safety model:
- Act commands are policy Class B (audited).
- Act requires explicit `HARNESS_DOM_ACT_ENABLED=1`.
- Act rejects non-local URLs (localhost/loopback/*.local/private LAN only).
- Non-local error: `[error] dom act local-only: URL not allowed (<url>)`.

## DOM read extras: `pick`, `near`, `path`, `diff`

Examples:

```bash
# pick structured fields from matched cards
npm run cli -- run 'dom --file sample.html pick "section.card" --fields "title:h3,text:.desc,href:a@href"'

# JSONL mode for unix pipelines
npm run cli -- run 'dom --file sample.html pick "li" --fields "text:." --jsonl | jq -c .'

# find nearest context containing text and extract targets
npm run cli -- run 'dom --file sample.html near "email" --within "form,section" --return "input@name,input@value"'

# build stable path selectors from a CSS selector
npm run cli -- run 'dom --file sample.html path --selector ".price" --style css --top 5'

# build ancestry paths from text match
npm run cli -- run 'dom --file sample.html path --text "Buy Now" --style ancestry --depth 3'

# user-style pipeline examples
npm run cli -- run 'dom near "Buy Now" --within "section,form" --return "." | dom --file sample.html path --style css'
npm run cli -- run 'dom --file sample.html pick ".price" --fields "text:." --jsonl | dom --file sample.html path --depth 3'

# diff compact snapshots from files
npm run cli -- run 'dom diff before.json after.json'

# diff inline stdin pair
npm run cli -- run 'printf "[{\"title\":\"A\"},{\"title\":\"B\"}]" | dom diff'
```

Composability tips:
- Use `jq` for field slicing/aggregation.
- Use `sed`/`awk` for lightweight stream transformations.
- `--jsonl` on `dom pick` is ideal for line-oriented pipelines.
