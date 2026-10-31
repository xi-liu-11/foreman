# Review round 1: task inbox --project

Reviewed `git diff main...HEAD` against `spec.md`, `plan.md` and the task brief.
The repo has no CLAUDE.md or constitution, so conventions were judged from the
surrounding code.

**Verdict: pass.** No blocking findings. Two advisory findings follow; neither
needs a change for this task to proceed.

## Checks run

| Check | Result |
| --- | --- |
| `bun test` | 34 pass, 0 fail |
| `bunx tsc --noEmit` | exit 0 |
| CLI against a stub server that logs requests | See below |
| `task ls --all --project inbox-test-a` and `"inbox test & co"` on the live taskd | Both `[]`: the tests did not leak into the real DB |
| Diff scope | Only `src/taskd.ts`, `src/cli.ts`, `test/inbox.test.ts`, `README.md` and the spec directory. `src/pipelines.ts`, `src/leases.ts` and `src/db.ts` are untouched |

Requests the CLI made against the stub server:

| Arguments | Exit | Requests |
| --- | --- | --- |
| `inbox` | 0 | `/blocks`, `/tasks?status=gate` |
| `inbox --project foo` | 0 | `/blocks?project=foo`, `/tasks?status=gate&project=foo` |
| `--project foo inbox` | 0 | `/blocks?project=foo`, `/tasks?status=gate&project=foo` |
| `inbox --project "a b&c" --json` | 0 | `/blocks?project=a%20b%26c`, `/tasks?status=gate&project=a%20b%26c` |
| `inbox --json --project` | 1 | None; prints `error: --project requires a name` |
| `inbox --project=foo` | 0 | `/blocks`, `/tasks?status=gate` (advisory finding 1) |

## Spec coverage

- Every row of the behaviour table holds. The unscoped request URLs match main,
  and the `out(...)` block is unchanged.
- Each of acceptance scenarios 1 to 11 has a test in `test/inbox.test.ts`.
- The `/blocks` filter matches the plan's code exactly. It sits behind the existing
  auth check in `route`.
- `show`, `approve`, `answer`, `retry` and `cancel` are unchanged.
- The help line keeps its description at column 34, in line with the neighbouring
  `task leases` line.

## Advisory findings

### 1. `--project=<name>` silently lists every project

- **File:** `src/cli.ts:184-185` (the root cause is `opt()` at `src/cli.ts:16-20`)
- **Failure scenario:** A session runs `task inbox --project=foreman`. `opt()` and
  `flag()` only match the exact token `--project`, so `project` is undefined and the
  missing-value check does not fire. The CLI exits 0 and shows every project's
  questions and gates, which is the outcome the missing-value check exists to
  prevent. `plan.md` line 98 says a missing value is "the one way this happens";
  this is a second way.
- **Why it does not block:** The spec does not list this form. No command in the CLI
  accepts `--flag=value`, and `task ls --project=foo` has the same pre-existing
  behaviour. The README and `--help` show only the space form.
- **Required change:** None for this task. A fix belongs in the shared argument
  handling as a separate change, for example rejecting any `--name=value` token.

### 2. Per-project sessions stay unscoped until the assistant skill changes

- **File:** `skills/foreman/SKILL.md:12` and `skills/foreman/SKILL.md:24`
- **Failure scenario:** An assistant session follows the skill's instruction to run
  `task inbox` every turn, so it still sees every project. The flag exists, but the
  brief's goal is not met in practice until something passes it.
- **Why it does not block:** `spec.md` puts this file out of scope, and the plan step
  raised the gap before the user approved the plan.
- **Required change:** None for this task. It needs a follow-up task to update the
  skill.
