# T0022 test round 1

**Verdict: pass.** All 11 acceptance scenarios and every row of the spec's behaviour
table pass, both in `bun test` and against a real taskd. There is one observation
outside the spec: `task inbox --project=a` is not scoped (see below).

## How it was checked

Project verification mode is `inspect`, so the branch was run and its output read.

| Check | Command | Result | Evidence |
| --- | --- | --- | --- |
| Unit and route tests | `bun test` | 34 pass, 0 fail | `test-round-1/bun-test.txt` |
| Same, with no `FOREMAN_*` in the environment | `bun test test/inbox.test.ts` | 17 pass, 0 fail | `test-round-1/bun-test.txt` |
| Typecheck | `bunx tsc --noEmit` | exit 0 | `test-round-1/tsc.txt` |
| End to end | `test-round-1/e2e.sh` | 0 failed | `test-round-1/e2e-output.txt` |

`e2e.sh` starts a real taskd on port 7787 in a temp `FOREMAN_HOME`, with
`test/fake-claude.sh` as the worker, so the blocks and gates come from real
pipeline runs rather than seeded rows. It clears inherited `FOREMAN_*` values and
leaves herdr off `PATH`. `task ls --project a` and `--project b` on the live taskd
afterwards returned `[]`, and the inbox tests left no rows there either.

`test/smoke.sh` was not run. It opens real herdr tabs and uses fixed ports, and
`e2e.sh` covers the paths this change touches.

## Acceptance scenarios

| # | Scenario | `bun test` | Real taskd |
| --- | --- | --- | --- |
| 1 | `GET /blocks?project=a` returns only `a`'s block, task embedded | pass | pass |
| 2 | `GET /blocks` returns both | pass | pass |
| 3 | `GET /blocks?project=none` returns `[]` | pass | pass |
| 4 | Answered block on `a` is not returned | pass | pass |
| 5 | `GET /tasks?status=gate&project=a` returns only the gated task, not a running one | pass | pass |
| 6 | `GET /tasks?status=gate` returns both | pass | pass |
| 7 | `task inbox --project a --json` has only `a`'s items | pass | pass, in either flag order |
| 8 | `task inbox --project a` text has only `a`'s items | pass | pass |
| 9 | `task inbox` text and JSON list both projects | pass | pass |
| 10 | `task inbox --project` exits 1 with the error and lists nothing | pass | pass, against an unreachable URL, so no request is made |
| 11 | `task --help` shows `--project` on the inbox line | pass | pass |

Other requirements from the spec and brief:

- **Empty and unknown projects:** `inbox empty` and `{ "blocks": [], "gates": [] }`, exit 0.
- **`--project ""`, `--json --project`, `--project --json`:** all give the error, exit 1.
- **No-flag output is unchanged:** the text, the JSON, `GET /blocks` and
  `GET /tasks?status=gate` are byte-identical to the merge base (90a8b34). That holds
  for the baseline CLI on the new taskd and for the baseline CLI on a baseline taskd
  over the same home. The relative age in the text output is normalised first,
  because it changes between runs.
- **Id commands:** `show`, `answer`, `approve` and `cancel` work on real tasks.
  `retry` was only exercised on its error paths (a blocked task, a missing id).
  All five return the same result as the baseline for a missing id, and the branch
  does not touch their code.
- **Scope:** `git diff main...HEAD` touches only `src/cli.ts`, `src/taskd.ts`,
  `test/inbox.test.ts`, `README.md` and the spec directory. There is no change to
  pipelines, leases or the schema.
- **README:** the `## Use` block documents the flag.

## Observation: `--project=a` is not scoped

Not a failure of this round: the spec does not cover the `=` form, and the help and
README only show `--project <name>`. It is still the outcome the spec's
missing-value error exists to prevent, a session that meant to scope itself silently
seeing every project.

To reproduce, run `test-round-1/e2e.sh` and read the "argument edge probes" section,
or against any taskd with tasks in two projects:

```
$ task inbox --project=a
questions:
  [1] T0003 (a blocked task) 19s ago
  [2] T0004 (b blocked task) 17s ago
...
[exit 0]
```

Expected: only `a`'s items, or an error. Actual: every project, exit 0. The cause is
that `opt()` and `flag()` in `src/cli.ts` only match the exact `--project` argument.
This predates the branch: `task ls --project=a` lists every project as well.

## Minor

The README's `## Testing` section still says `bun test` runs `test/leases.test.ts`;
it now also runs `test/inbox.test.ts`.

## Reproducing

```
bun test
bunx tsc --noEmit
specs/t0022-task-inbox-project-scope/qa/test-round-1/e2e.sh
```

`e2e.sh` needs port 7787 free, plus `bun`, `git`, `curl` and `python3`. It exits
non-zero if any check fails, and takes under a minute.
