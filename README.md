# local-ai-harness v1

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

## File layout

- `src/parser.js`
- `src/executor.js`
- `src/presenter.js`
- `src/policy.js`
- `src/trace.js`
- `src/run.js`
- `src/server.js`
- `src/cli.js`
- `test/harness.test.js`
