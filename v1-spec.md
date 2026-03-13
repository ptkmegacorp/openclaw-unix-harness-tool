# local-ai-harness v1 spec

## Objective
Build a Unix-native agent harness centered on a **single tool surface**:

- `run(command="...")`

with strict semantics and safety rails so agents can compose workflows reliably without token waste.

---

## 1) Architecture

## Layer 1: Execution (Unix semantics, lossless)
- Parse and execute chain operators: `|`, `&&`, `||`, `;`
- Preserve raw stdout/stderr bytes internally
- Preserve exact exit codes per stage
- No truncation, no metadata injection in pipeline data path

## Layer 2: Presentation (LLM-facing)
Applied only to final result returned to model:
- Text/binary classification
- Overflow/truncation policy
- stderr attachment policy
- metadata footer: `[exit:N | 123ms]`

**Rule:** Layer 2 must never change Layer 1 pipeline behavior.

---

## 2) Command Policy Classes

### Class A — Read-only (default allow)
Examples: `cat`, `ls`, `grep`, `find`, `head`, `tail`, `wc`, `jq`.

### Class B — Reversible write (allow with audit)
Examples: write into workspace temp/cache, file rename within workspace.
Requires operation log.

### Class C — Destructive/External (guarded)
Examples: `rm`, outbound network sends, system service changes.
Requires explicit approval gate (typed side-channel confirmation).

---

## 3) Safety Contract

## 3.1 Execution budget guards
- Max chain segments: 12
- Max wall time per call: 60s (configurable)
- Max returned text before overflow mode: 50KB or 200 lines
- Max intermediate pipe memory: bounded stream buffer with spill-to-temp

## 3.2 Forbidden-by-default patterns
- shell glob deletes on root/system paths
- writing outside configured workspace unless policy grants
- outbound messaging/posting commands without explicit confirmation

## 3.3 Confirmation side-channel (typed)
Two explicit confirmation intents:
- `confirm_delete(targets[])`
- `confirm_external_send(channel, destination)`

If not confirmed, return deterministic refusal + suggested next step.

---

## 4) Output Contract (LLM-facing)

## 4.1 Success
```
<content>
[exit:0 | 42ms]
```

## 4.2 Failure with stderr
```
<stdout maybe empty>
[stderr] <stderr trimmed if needed>
[exit:127 | 9ms]
```

## 4.3 Overflow mode
```
<first chunk>

--- output truncated (5000 lines, 245.3KB) ---
Full output: /tmp/cmd-output/cmd-17.txt
Explore: cat /tmp/cmd-output/cmd-17.txt | grep <pattern>
         cat /tmp/cmd-output/cmd-17.txt | tail 100
[exit:0 | 1.2s]
```

## 4.4 Binary guard
- If likely image/binary: refuse text return, instruct proper command (`see`, `cat -b`, etc.)

---

## 5) Deterministic Error UX
Every error must include:
1. what failed
2. why (if known)
3. what to do next

Example:
```
[error] unknown command: foo
Available: cat, ls, see, write, grep, memory, clip
```

---

## 6) Observability / Trace
Each `run` call emits trace record:
- `timestamp`
- `command_raw`
- `cwd`
- `policy_class`
- `exit_code`
- `duration_ms`
- `stdout_sha256`
- `stderr_sha256`
- `truncated(bool)`
- `artifact_path(optional)`

Store as JSONL in `./logs/run-trace.jsonl`.

---

## 7) Initial Implementation Milestones
1. Parser + executor for `| && || ;`
2. Presentation layer wrapper
3. Safety gates + policy classes
4. Trace logging
5. Regression tests (see `v1-test-matrix.md`)
