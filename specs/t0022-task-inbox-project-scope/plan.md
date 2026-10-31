# Plan: task inbox --project

See `spec.md` for behaviour and acceptance scenarios.

## Approach

Filter server-side. `GET /tasks` already takes `project`, so only `GET /blocks`
needs it. The CLI passes the flag to both routes and its rendering stays as is.

No `Store` change: the `/blocks` route already loads each block's task, so it
filters on `task.project`. An open-block list is short, so a SQL join would add a
method without a real saving.

`route` becomes an export so tests can call it directly. Importing `taskd.ts`
starts no server or tick loop; only `main()` does. Checked: an import under a temp
`FOREMAN_HOME` only creates the config and DB there.

## Files, in order

### 1. `src/taskd.ts`

`export` on `async function route`, and replace the `/blocks` handler:

```ts
if (p === "/blocks" && req.method === "GET") {
  const project = url.searchParams.get("project");
  const blocks = store.openBlocks().map(b => ({ ...b, task: store.getTask(b.task_id) }));
  return json(project ? blocks.filter(b => b.task?.project === project) : blocks);
}
```

### 2. `src/cli.ts`

Replace the two fetches at the top of `case "inbox"`. Leave the `out(...)` call
alone so unscoped output does not change.

```ts
const project = opt("project");
if (flag("project") && !project) die("--project requires a name");
const scope = project ? `project=${encodeURIComponent(project)}` : "";
const blocks: any[] = await client.get(`/blocks${scope && `?${scope}`}`);
const gates: any[] = await client.get(`/tasks?status=gate${scope && `&${scope}`}`);
```

Help line, keeping the description at column 34:

```
  task inbox [--project <name>]   open questions and gates waiting on you
```

### 3. `test/inbox.test.ts` (new)

Follow `test/leases.test.ts`: set `process.env.FOREMAN_HOME` to a temp dir, then
use dynamic imports.

- Build requests with the token from `loadConfig().server.token`.
- Seed through `new Store()`, a second WAL handle on the same default DB that
  taskd's module-level store uses. Do not pass a path: `bun test` may share
  modules between files, so `FOREMAN_HOME` as seen by `config.ts` can be another
  test file's temp dir. The default path follows whichever one `config.ts` holds.
- Seed with project names unique to this file, and assert by project rather than
  on total counts if the DB could be shared.
- A block needs a step: `insertTask`, `insertStep`, then `insertBlock`.

Route tests call `route(new Request("http://x/blocks?project=a", { headers }))`
for scenarios 1 to 6.

CLI tests start `Bun.serve({ port: 0, fetch: route })` and spawn
`bun src/cli.ts inbox ...` with `Bun.spawn` for scenarios 7 to 11. The spawned env
must set all of these, because a Foreman worker inherits live values for them:

- `FOREMAN_URL`: the test server
- `FOREMAN_TOKEN`: the test token
- `FOREMAN_CLI_NAME=task`: otherwise a `foreman` value selects the wrong CLI
- `FOREMAN_HOME`: the temp dir

Never let a test reach the real taskd at the inherited `FOREMAN_URL`.

### 4. `README.md`

In the `## Use` block, after the `task inbox` line:

```sh
task inbox --project foreman   # only that project's questions and gates
```

## Verification

| Slice | Check |
| --- | --- |
| Route and CLI | `bunx tsc --noEmit` (does not cover `test/`; `tsconfig.json` includes only `src/`) |
| Tests | `bun test`: the 17 existing tests plus the new file, all green |
| Unscoped regression | `git diff src/cli.ts` shows the `out(...)` block untouched; scenario 9 passes |
| Docs | `bun src/cli.ts --help` with `FOREMAN_CLI_NAME=task` shows the flag; `git diff --stat` lists only `src/taskd.ts`, `src/cli.ts`, `test/inbox.test.ts`, `README.md` and this spec directory |

## Risks

- **Scoped session sees other projects.** `--project` with no value is the one way
  this happens, and it is now an error, covered by scenario 10.
- **Typo looks like an empty inbox.** Accepted to match `task ls`; see `spec.md`.
- **Encoding.** Names with spaces or `&` must survive; `encodeURIComponent` handles
  them, and the route compares the decoded value.
- **Exporting `route`.** It widens the module's surface by one symbol; `main()` is
  still the only caller outside tests.
- **Tests leaking into live state.** Worker env carries a real `FOREMAN_URL`,
  `FOREMAN_TOKEN` and `FOREMAN_HOME`. Plan step 3 overrides all of them.
