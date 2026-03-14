# LLM Harness Command Family Spec (`llm`)

## Scope
Local-first, read-only command family for llama.cpp OpenAI-compatible endpoints through `run(command)`.

## Commands
- `llm health [--json|--text]`
- `llm models [--json|--text]`
- `llm chat "<prompt>" [--system "..."] [--model "..."] [--temp N] [--max-tokens N] [--json|--text]`
- `llm embed "<text>" [--model "..."] [--json|--text]`
- `llm tokenize "<text>" [--json|--text]`

## Deterministic Output Contracts
- Exit codes:
  - `0` success
  - `1` endpoint/network failure
  - `3` command family disabled
  - `4` embed unsupported
- JSON mode (`--json`) emits exactly one JSON object line.
- Text mode emits compact, pipe-safe plain text.
- Error messages are prefixed with `[error]` and deterministic.

## Composability
- `--json` for machine composition (`jq`, `sed`, `awk`).
- `--text` for simple unix pipelines.
- Chat text mode emits only assistant output (newline-terminated).
- Models text mode emits one model id per line.

## Safety + Timeouts
- Policy class: **A** (read-only/safe).
- No writes, no external network beyond local configured endpoints.
- Per-request timeout controlled by `HARNESS_LLM_TIMEOUT_MS` (default 12000ms).

## Local-First Behavior
- Endpoint list from `HARNESS_LLM_ENDPOINTS` (default `http://127.0.0.1:8080,http://127.0.0.1:8081`).
- Sequential failover: first healthy/success endpoint wins.
- If all endpoints fail: deterministic aggregate error.
- If tokenize unsupported: deterministic token estimate fallback (`ceil(chars/4)`).
- If embeddings unsupported on all endpoints: deterministic unsupported error.

## Config
- `HARNESS_LLM_TOOLS_ENABLED=1|0` (default `1`)
- `HARNESS_LLM_ENDPOINTS=comma,separated,urls`
- `HARNESS_LLM_DEFAULT_MODEL=<model>`
- `HARNESS_LLM_MODEL=<model>` (legacy/default fallback)
- `HARNESS_LLM_TIMEOUT_MS=<int>`
