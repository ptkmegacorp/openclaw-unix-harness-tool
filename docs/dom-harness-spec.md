# DOM Harness Spec (Read + Local Act)

## Goals
- Token-efficient HTML extraction for LLM workflows.
- Deterministic compact JSON outputs.
- Safe by default with explicit higher-risk act toggle.

## Command Surface
All commands run under `dom`.

### Read sources
- `--url <URL>` (read-mode fetch)
- `--file <PATH>` (read local file)
- default URL (read mode only): `https://example.com`

### Read commands (Class A)
- `dom [--url URL|--file FILE] query "<selector>" [--top N] [--text]`
- `dom [--url URL|--file FILE] find-text "<text>" [--context N]`
- `dom [--url URL|--file FILE] extract links [--contains X]`
- `dom [--url URL|--file FILE] snapshot --schema compact`

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
- STDOUT: single compact JSON line + newline.
- STDERR: deterministic `[error] ...` messages.
- `snapshot --schema compact` is deterministic and token-efficient.
