# T0011 test round 1 — verdict: PASS

Mode: inspect. Evidence is in `qa/test-round-1/`.

| # | Scenario | How verified | Result |
|---|----------|--------------|--------|
| 1 | Grant order | `bun test` "grant order and queue positions"; live smoke (T0001 held → T0002 #1, T0003 #2 → release → T0002 granted, `waited_sec` 46) | pass |
| 2 | Re-entrancy | `bun test` "re-entrant requests"; smoke: second `task lease ios-sim` from the holder wrote no event | pass |
| 3 | Auto-release (done/failed/blocked/heartbeat/task cancelled/task failed) | `bun test` (one test per state + reconcile sweep variants); smoke: `POST /tasks/T0002/cancel` released with `why: "task cancelled"` and T0003 was granted | pass |
| 4 | Restart | `bun test` "restart: state visible from a second Store" | pass |
| 5 | Per-machine / per-project scoping | `bun test` "scoping by project and machine"; smoke: P/mini and Q/local granted while P/local was held with a queue | pass |
| 6 | Overdue | `bun test` "overdue is flagged once and lease is kept" | pass |
| 7 | Undeclared name | `bun test`; smoke: `task lease ios-sm` printed the warning on stderr, was granted, event has `undeclared: true`, taskd logged it | pass |
| 8 | Fencing (409) | smoke: lease on a done step and on a running step of a cancelled task → 409 `step is not running`, `/leases` stays empty | pass |
| 9 | Prompt paragraph | `bun test` "devicePrompt"; `device-prompt.txt` shows the full paragraph (wait/exit 3/Bash timeout/alphabetical/never kill); empty for architect; slot present in `prompts/worker-preamble.md` | pass |
| 10 | CLI | smoke: waiting line immediately and again 30 s later (`for 7s` → `for 37s`), `granted` after the holder released; `--wait 5` exits 3 and keeps the place (`task leases` still lists #1/#2); `task leases` and `task show` list holder and queue | pass |
| 11 | `bunx tsc --noEmit`, `bun test` | `tsc.txt` (exit 0), `bun-test.txt` (17 pass, 0 fail) | pass |

Not run: `test/smoke.sh` (needs a herdr workspace and real Claude workers; out of reach for this headless step). Dashboard checked only to the extent that the served page contains the Devices block; it was not rendered in a browser.

## Reproduce

```
bun test
bunx tsc --noEmit
specs/t0011-resource-leases-workers-take/qa/test-round-1/smoke.sh   # ~60 s; starts a throwaway taskd on port 17791 with a temp FOREMAN_HOME
```

## Observations (not failures)

- `task lease X` repeated by the holder within ~1 s of the grant prints `lease X granted` instead of `already held`; the CLI decides by comparing the holder's `since` with its own start time minus 1 s. No event or row is written, so behaviour is correct; only the wording differs. Cosmetic.
- Reminder for handoff: taskd must be restarted to pick the feature up, and tackle-tally needs `resources = ["ios-sim", "android-emu"]` in `~/.foreman/config.toml`.
