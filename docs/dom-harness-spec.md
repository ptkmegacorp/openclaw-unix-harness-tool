# DOM Harness Spec (Optional Plugin)

## Goals
- Token-efficient HTML extraction for LLM workflows.
- Deterministic, compact JSON outputs for easy piping/composition.
- Safe by default (read-only mode).

## Command Surface
All commands run under `dom`.

### Sources
- `--url <URL>`: fetch remote HTML (GET, read mode)
- `--file <PATH>`: read local HTML file
- If source omitted: defaults to `https://example.com`

### Commands
1) `dom query "<selector>" [--top N] [--text]`
- Select elements by CSS selector.
- Output fields: `i`, `tag`, `id`, `cls`, optional `text`.

2) `dom find-text "<text>" [--context N]`
- Finds first text matches in DOM text content.
- Output fields: `tag`, `id`, `text` snippet.

3) `dom extract links [--contains X]`
- Extracts `a[href]` links with anchor text.
- Optional contains filter applies to href or text.

4) `dom snapshot --schema compact`
- Compact page summary for planning/indexing.
- Output: title, counts (links/forms), first headings, compact body text.

## Output Contract
- STDOUT: single-line JSON object (plus trailing newline).
- STDERR: `[error] ...` deterministic messages.
- Deterministic order: stable keys and bounded arrays.
- Compact text normalization:
  - collapse whitespace
  - hard truncate with ellipsis
  - bounded result counts

## Safety Modes
### Read Mode (default, Class A)
- Allowed commands: query/find-text/extract links/snapshot
- Inputs: URL fetch, local file read
- No mutation, no browser automation, no script execution.

### Optional Act Mode (future)
- Reserved for DOM interaction primitives (click/type/eval).
- Must be explicit (`--mode act`) and separately policy-gated.
- Not enabled in v1 implementation.

## Toggle
- `HARNESS_DOM_ENABLED=1` (default): enabled
- `HARNESS_DOM_ENABLED=0`: deterministic disabled error:
  - `[error] dom harness disabled (HARNESS_DOM_ENABLED=0)`
