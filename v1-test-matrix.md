# v1 test matrix

## A) Unix semantics integrity
- `echo a | wc -c` returns expected count
- `false && echo x` does not run second command
- `false || echo ok` runs fallback
- `echo a ; echo b` always runs both

## B) Layer separation
- Large intermediate output in pipe still yields correct downstream result
- Metadata footer never appears in downstream pipe data

## C) Overflow behavior
- >200 lines result truncates + writes artifact file
- artifact path readable + contents full
- UTF-8 boundary safe truncation (no broken rune)

## D) Binary guard
- PNG via `cat` returns guard error with recommended command
- text file never misclassified as binary

## E) stderr policy
- failing command preserves stderr in output contract
- command-not-found returns `exit:127` and stderr hint

## F) Safety classes
- Class A commands pass without confirmation
- Class B write emits audit log entry
- Class C destructive blocked without explicit confirm intent

## G) Budget controls
- command exceeding runtime limit is terminated with deterministic timeout error
- chain segment count > max rejected before execution

## H) Trace logging
- each run appends JSONL row with required fields
- hashes present + consistent for same output

## I) Recovery UX
- unknown command message includes available alternatives
- wrong file mode error includes exact correction command
