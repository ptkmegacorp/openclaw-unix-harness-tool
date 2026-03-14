# DOM Harness Spec (Read + Local Act)

## Goals
- Token-efficient HTML extraction for LLM workflows.
- Deterministic compact JSON outputs.
- Unix-style composability: stream-first outputs, orthogonal flags, jq/sed/awk friendly.

## Command Surface
All commands run under `dom`.

### Read sources
- `--url <URL>` (read-mode fetch)
- `--file <PATH>` (read local file)
- default URL (read mode only): `https://example.com`

### Read commands (Class A)
- `dom [--url URL|--file FILE] query "<selector>" [--top N] [--text]`
- `dom [--url URL|--file FILE] pick "<selector>" --fields "name:sel,name2:sel@attr" [--top N] [--jsonl]`
- `dom [--url URL|--file FILE] near "<needle text>" --within "form,section" --return "input@name,input@value"`
- `dom [--url URL|--file FILE] find-text "<text>" [--context N]`
- `dom [--url URL|--file FILE] path --selector "<selector>" [--style css|ancestry] [--depth N] [--top N]`
- `dom [--url URL|--file FILE] path --text "<needle>" [--style css|ancestry] [--depth N] [--top N]`
- `dom [--url URL|--file FILE] extract links [--contains X]`
- `dom [--url URL|--file FILE] snapshot --schema compact`
- `dom diff [left.json right.json]`
- `dom diff --left left.json --right right.json`
- `cat pair.json | dom diff` where `pair.json` is `[left,right]` or `{"left":...,"right":...}`

### pick contract
- Inputs:
  - positional selector (`<selector>`) selects row roots.
  - `--fields` CSV of `name:selector` or `name:selector@attr`.
- Output:
  - default: `{"cmd":"pick","selector":"...","count":N,"rows":[...]}`
  - with `--jsonl`: one JSON object per line (no wrapper), stable field order.

### near contract
- Inputs:
  - positional needle text.
  - `--within` CSV of candidate container selectors (default `body`).
  - `--return` CSV of `selector` or `selector@attr` extracted from selected container.
- Selection:
  - candidate containers must contain needle (case-insensitive).
  - best container is deterministic: smallest text length, then shallowest depth, then earliest occurrence.
- Output:
  - `{"cmd":"near","found":bool,"context":...,"returns":[{"spec":"...","values":[...]}]}`

### path contract
- Purpose:
  - generate stable CSS selectors/ancestry paths from selector/text/previous dom output where feasible.
- Inputs:
  - selector mode: `--selector "<sel>"`
  - text mode: `--text "<needle>"`
  - pipeline mode: stdin JSON/JSONL rows from prior `dom` commands (best-effort resolution by `cssPath|selector|id|text|tag`).
  - flags: `--style css|ancestry` (default `css`), `--depth N`, `--top N`.
- Output row shape (deterministic, compact):
  - `tag`, `id`, `classes[]`, `cssPath`, `ancestry[]` (plus metadata fields).

Examples:
- `dom near "Buy Now" | dom path --style css`
- `dom pick ".price" | dom path --depth 3`

### diff contract
- Inputs:
  - two JSON snapshots via files/flags or stdin.
  - stdin accepted forms: `[left,right]`, `{left,right}`, or two JSON lines.
- Output:
  - `{"cmd":"diff","counts":{"added":A,"removed":R,"changed":C},"keyPaths":{...}}`
  - `keyPaths` contains deterministic sorted path samples (up to 20 each).

### Act commands (Class B, local-only)
- `dom --url <local-url> act click "<selector>"`
- `dom --url <local-url> act type "<selector>" "<text>"`
- `dom --url <local-url> act select "<selector>" "<value>"`
- `dom --url <local-url> act press "<key>"`
- `dom --url <local-url> act wait-text "<text>" [--timeout-ms N]`
- `dom --url <local-url> act snapshot --schema compact`

## Local URL allowlist for Act
Act mode accepts only local targets:
- `localhost`, `127.0.0.1`, `::1`
- `home.local`, `*.local`
- private/link-local IPv4 ranges: `10/8`, `172.16/12`, `192.168/16`, `169.254/16`

Non-local URL error is deterministic:
- `[error] dom act local-only: URL not allowed (<url>)`

## Toggles
- `HARNESS_DOM_ENABLED=1` (default) / `0` disables all dom commands.
- `HARNESS_DOM_ACT_ENABLED=0` (default) / `1` enables act commands.

Disabled act error:
- `[error] dom act disabled (HARNESS_DOM_ACT_ENABLED=0)`

## Output contract
- STDOUT: compact JSON + newline.
- STDERR: deterministic `[error] ...` messages.
- Read commands (`query/pick/near/path/find-text/extract/snapshot/diff`) are Class A.
