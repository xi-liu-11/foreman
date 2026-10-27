# Tasks: task log command

See `plan.md` for details and verification commands.

## Slice 1 — shared renderer

- [x] T1 Create `src/pretty.ts` exporting `short` and `prettyEvent`, moved verbatim from `src/runner.ts`.
- [x] T2 In `src/runner.ts`, delete the local `short`/`prettyEvent` and `import { prettyEvent } from "./pretty"`. (depends on T1)
- [x] T3 `bunx tsc --noEmit`; diff moved bodies against `git show HEAD:src/runner.ts`. Commit "Move prettyEvent into src/pretty.ts".

## Slice 2 — CLI command and docs

- [x] T4 In `src/cli.ts`, add imports (`join`, `existsSync`, `readFileSync`, `RUNS_DIR`, `prettyEvent`) and the `case "log":` handler per plan.md (step/attempt resolution, missing-transcript error, `--json`, `--tail`, integer validation). (depends on T1)
- [x] T5 Add the `task log` line to `TASK_HELP` in `src/cli.ts` (same file as T4; do it in the same pass).
- [x] T6 [P] Add one `task log` line to the README `## Use` code block (touches only README.md; can run alongside T1–T5).
- [x] T7 `bunx tsc --noEmit`; run every check in plan.md "Slice 2" against T0001 and record outputs with `task note`. Commit "Add task log command".
