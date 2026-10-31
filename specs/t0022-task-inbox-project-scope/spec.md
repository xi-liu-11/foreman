# task inbox --project: scope the inbox to one project

_Created by Foreman T0022._

## Goal

The user runs one assistant session per project, so a session must be able to
see only its own project's questions and gates. `task ls --project` already
works; `task inbox` ignores the flag and shows every project.

## Scope

- `task inbox --project <name>` shows only blocks and gates whose task belongs
  to that project, in both text and `--json` output.
- `GET /blocks` accepts an optional `project` query parameter. `GET /tasks`
  already does.
- `task --help` and the README's Use section document the flag.
- Tests cover the filter on both routes and the CLI wiring.

## Behaviour

| Invocation | Result |
| --- | --- |
| `task inbox` | Every project, byte-for-byte as today |
| `task inbox --project a` | Only project `a`'s blocks and gates |
| `task inbox --project a --json` | `{ blocks, gates }`, same shape, both lists filtered |
| `task inbox --project a` with nothing open for `a` | `inbox empty` (`{ "blocks": [], "gates": [] }` with `--json`), exit 0 |
| `task inbox --project` or `--project ""` | `error: --project requires a name`, exit 1 |
| `task inbox --project typo` | Same as an empty inbox, exit 0 (matches `task ls --project typo`) |

The missing-value error is deliberate. `opt()` returns `undefined` for a trailing
`--project`, so without a check a session that meant to scope itself would
silently see every project.

Project names match exactly. An empty `project=` on `GET /blocks` means no
filter, as it already does on `GET /tasks`.

## Acceptance scenarios

Given project `a` has one open block and one gated task, and project `b` has the
same:

1. `GET /blocks?project=a` returns only `a`'s block, with its `task` embedded.
2. `GET /blocks` returns both blocks.
3. `GET /blocks?project=none` returns `[]`.
4. An answered block on `a` is not returned by `GET /blocks?project=a`.
5. `GET /tasks?status=gate&project=a` returns only `a`'s gated task, and not a
   running task in `a`.
6. `GET /tasks?status=gate` returns both gated tasks.
7. `task inbox --project a --json` returns `a`'s block and gate and nothing of `b`.
8. `task inbox --project a` text names `a`'s items and none of `b`'s.
9. `task inbox` text and JSON list both projects.
10. `task inbox --project` exits 1 with the error above and makes no scoped or
    unscoped listing.
11. `task --help` shows `--project` on the inbox line.

`task show`, `approve`, `answer`, `retry` and `cancel` take ids and do not change.

## Out of scope

- Pipelines, leases, the DB schema and `Store` methods.
- Rejecting unknown project names. `GET /tasks` and `task ls` do not validate
  either, and a project removed from config can still have open tasks.
- A default project taken from the environment or the working directory.
- The dashboard, which keeps its all-project view.
- `skills/foreman/SKILL.md`. Its "every turn" instruction still runs an unscoped
  `task inbox`; teaching the assistant to pass the flag is a separate change.
