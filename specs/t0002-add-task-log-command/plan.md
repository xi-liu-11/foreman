# Plan: task log command

## Approach

Two small slices, no new abstractions beyond one shared module.

1. **Extract rendering.** Create `src/pretty.ts` exporting `prettyEvent(ev)`
   and `short(s, n)`, moved verbatim (same ANSI codes, same truncation lengths)
   from `src/runner.ts`. `runner.ts` deletes its local copies and imports
   `prettyEvent` (and `short` only if it still uses it elsewhere — check with
   grep; today `short` is only called from `prettyEvent`). No behaviour change.

2. **Add `task log` to `src/cli.ts`.** A new `case "log":` in `taskMain`,
   following the style of the neighbouring cases (inline, `die` for errors,
   `opt`/`rest` for args):

   ```ts
   case "log": {
     const id = rest[0] ?? die("task id required");
     const d = await client.get(`/tasks/${id}`);
     const steps: any[] = d.steps;
     if (!steps.length) die(`${id} has no steps yet`);
     const name = rest[1] ?? steps[steps.length - 1].name;
     const named = steps.filter(s => s.name === name);
     if (!named.length) die(`no step '${name}' on ${id}`);
     const attempt = opt("attempt") ? Number(opt("attempt")) : Math.max(...named.map(s => s.attempt));
     if (!named.some(s => s.attempt === attempt)) die(`no attempt ${attempt} of step '${name}' on ${id}`);
     const path = join(RUNS_DIR, id, `${name}-${attempt}`, "transcript.jsonl");
     if (!existsSync(path)) die(`no transcript at ${path}`);
     const raw = readFileSync(path, "utf8").split("\n").filter(l => l.trim());
     let lines: string[];
     if (jsonOut) lines = raw;
     else lines = raw.flatMap(l => { let ev; try { ev = JSON.parse(l); } catch { return [l]; } const p = prettyEvent(ev); return p ? p.split("\n") : []; });
     const tail = opt("tail");
     console.log((tail ? lines.slice(-Number(tail)) : lines).join("\n"));
     return;
   }
   ```

   Notes for the developer:
   - `jsonOut` is the existing global `--json` flag; here it means "raw events",
     so do **not** route through `out()` (which would `JSON.stringify` an array).
   - Use `d.task.id` rather than the user-typed `id` for the path if taskd
     normalises ids (check `GET /tasks/:id` — if it accepts lower case, use
     `d.task.id`). Safe default: use `d.task.id`.
   - `positional()` already skips the value after `--attempt`/`--tail`, so
     `rest` is `[id, stepName?]`.
   - Validate `--attempt`/`--tail` are positive integers; otherwise
     `die("--tail must be a positive integer")` etc.
   - Empty output (nothing renderable) prints nothing and exits 0.
   - Imports to add: `join` from `node:path` (cli already imports `basename`),
     `existsSync`, `readFileSync` from `node:fs`, `RUNS_DIR` from `./config`,
     `prettyEvent` from `./pretty`.

3. **Docs.** Add to `TASK_HELP` under User commands:
   `task log <id> [step] [--attempt N] [--tail N]   transcript of a step run (--json for raw events)`
   (align with existing columns). README `## Use` code block: add
   `task log T0001 [research] [--attempt N] [--tail N]   # what the worker did`.

## Files to touch, in order

1. `src/pretty.ts` (new)
2. `src/runner.ts` (remove `short`/`prettyEvent`, add import)
3. `src/cli.ts` (imports, `case "log"`, `TASK_HELP`)
4. `README.md` (one line in Use)

## Verification per slice

- Slice 1 (pretty extraction):
  - `bunx tsc --noEmit` passes.
  - `git diff src/runner.ts` shows only the removed functions and one import
    line; `diff` the moved function bodies against `git show HEAD:src/runner.ts`
    to confirm they are verbatim.
- Slice 2 (CLI), with taskd running (`foreman health` ok):
  - `task log T0001` → renders `research-3`.
  - `task log T0001 research --attempt 1` → long rendered transcript with
    `▶` tool lines and a final `[result]` line.
  - `task log T0001 research --attempt 1 --tail 5 | wc -l` → 5.
  - `task log T0001 --json --attempt 1 | head -3` → raw JSON lines.
  - `task log T0001 nosuchstep; echo $?` → one-line error, `1`.
  - `task log T0001 research --attempt 9; echo $?` → one-line error, `1`.
  - Missing transcript: `FOREMAN_HOME=$(mktemp -d) task log T0001` (if
    `FOREMAN_HOME` is honoured by config.ts and the client still reaches taskd),
    or temporarily rename a transcript copy — do not modify `~/.foreman/runs`
    content permanently. Expect `error: no transcript at …`, exit 1.
  - `task help | grep 'task log'`.
  - `bunx tsc --noEmit` passes.
- Slice 3 (docs): eyeball README diff (one line).

## Risks

- **Runner regression** from the move: mitigated by moving code verbatim and
  diffing. `short` must keep its default `n = 160`.
- **`--json` semantics clash**: the global `--json` normally means "JSON of the
  API response"; for `log` it means raw JSONL. Documented in help text.
- **Step name vs attempt mismatch**: transcripts are keyed by
  `<step-name>-<attempt>`, matching `runner.ts`/`taskd.ts` (`runDirFor`). Parallel
  children have their own names, so no collision.
- **taskd down**: `client.get` throws; the top-level catch already prints a
  one-line `error:` and exits 1. Acceptable (brief requires the step list from
  taskd).
- **Remote machine runs** (`s.machine`) keep transcripts elsewhere; they surface
  as the "no transcript" error. Out of scope.
