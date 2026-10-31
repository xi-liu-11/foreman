# Superseded status: task close --superseded-by and create --continues

_Created by Foreman T0023._

## Goal

Foreman has no honest closing status for a task whose work another task finished.
T0015 passed QA and its merge was approved, but the merge step failed on a rebase
conflict and the work shipped through T0019 on the same branch. `task cancel` reads
as abandoned. Add a terminal `superseded` status with a pointer to the task that
carried the work on.

## Behaviour

`superseded` is a terminal status alongside `done`, `failed` and `cancelled`.
`tasks.superseded_by` holds the successor's id and is null otherwise.

Closing as superseded does what cancel does: open questions are closed, running
steps are told to stop, and their resource leases are released. Like cancel, it does
not touch the worktree or the branch, because a successor on the same branch adopts
that same worktree path (`attachWorktree` in `src/git.ts`).

### `task close <id> --superseded-by <other>`

Allowed when `<id>` is `failed`, `cancelled`, `gate` or `blocked`. Refused when:

- `<id>` is in any other status, including already `superseded`
- `<other>` does not exist
- `<other>` is `<id>`
- following `superseded_by` from `<other>` reaches `<id>`, which would be a cycle

A refusal changes nothing. On success the old task gets the event `task.superseded`
("superseded by T0019") and the successor gets `task.continues` ("continues T0015").

### `task create ... --continues <id>`

Optional, and normally combined with `--branch <b> --start-at <step>`. The continued
task must pass the same status check, and that check runs before a task id or
worktree is allocated. The new task and the close commit in one transaction. If
create fails for any reason, the continued task stays as it was.

### Tickets

Closing as superseded never posts a "failed" comment and never transitions the
ticket. If the old task has a ticket and it differs from the successor's, the old
ticket gets one comment: `Continued as <successor id>`. A shared ticket gets no
comment, because the successor's own comments cover it. Ticket errors are logged as
`ticket.error` events and do not undo the close.

### Display

- `task ls --all`: `superseded→T0019` in the status column, not truncated.
- `task show`: a `superseded by: T0019` line directly under the status line.
- `foreman watch`: the recent list shows the same label as `task ls`.
- Dashboard: the header counts `failed` and `superseded` separately; the Recent table
  shows the pointer; superseded tasks never appear under "Needs you".
- `task ls` without `--all` and `task inbox` never list a superseded task.

## Acceptance scenarios

Status transition

1. A `failed`, a `cancelled`, a `gate` and a `blocked` task each close as superseded:
   status `superseded`, `superseded_by` set, one event on each of the two tasks.
2. Closing a `blocked` task answers its open questions with `(task superseded)`.
3. Closing a task with a running step releases that step's resource lease, and the
   step's next heartbeat returns `cancel: true`.
4. A late worker result on a superseded task leaves the task `superseded`, including a
   result of `blocked`. The step ends `failed`.
5. A `task block` from a worker of a superseded task is answered at once, so it never
   reaches the inbox.
6. The scheduler tick does not create or launch a step for a superseded task, even for
   a `blocked` task whose questions were all closed by the supersede.

Refusals

7. `queued`, `running`, `done` and `superseded` tasks are refused, and nothing changes.
8. An unknown `<other>`, `<other>` equal to `<id>`, and a cycle are each refused, and
   nothing changes.
9. `task close <id>` without `--superseded-by`, or with an empty value, exits 1 and
   makes no request.
10. `task cancel` and `task retry` on a superseded task are refused.

`--continues`

11. `task create --continues <failed id>` creates the task, closes the old one as
    superseded by it, and records both events.
12. `--continues` with an unknown id or a `running` task returns an error, and no task
    or worktree is created.
13. `--branch <b> --start-at <step> --continues <id>` where the old task's worktree
    holds `<b>` and is clean: the new task adopts the worktree, starts at `<step>`, and
    the old task is superseded.
14. The same command where `<b>` does not exist or the worktree is dirty: create fails
    and the old task keeps its status.
15. `--continues` with no value exits 1 and makes no request.

Rendering and tickets

16. `task ls --all` prints the full `superseded→<id>`; the column widens only when a
    superseded row is shown, so other listings are byte-identical to today.
17. `task show` prints `superseded by: <id>` under the status line; `--json` output
    carries `superseded_by`.
18. `task ls` and `task inbox` leave out superseded tasks, including ones closed from
    `blocked` with an open question and from `gate`.
19. Different tickets: exactly one comment, `Continued as <id>`, on the old ticket, and
    no state transition. Same ticket, or no ticket: no comment.
20. A ticket provider error leaves the task superseded and records `ticket.error`.
21. `task --help` documents `close` and `--continues`.

## Out of scope

- Applying this to T0015. taskd must be restarted first, so the assistant runs
  `task close T0015 --superseded-by T0019` after the merge. The handoff says so.
- Pipeline changes.
- Removing worktrees or branches, or closing herdr tabs, when a task is superseded.
  Cancel does none of these either.
- Inferring `--branch` from `--continues`, or requiring the two tasks to share a branch
  or a project. The assistant passes the ids deliberately.
- Reopening a superseded task.
- A guard on `task cancel` for other finished statuses (`done`, for example). Only
  `superseded` gets one here.
