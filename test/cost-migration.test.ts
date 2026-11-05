import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-cmig-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
const { DB_PATH } = await import("../src/config");
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { Store } = await import("../src/db");
afterAll(() => rmSync(home, { recursive: true, force: true }));

// The steps table as it was before T0055 (no session_cost_usd, cost_estimated, cost_unknown).
const OLD_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
  status TEXT NOT NULL, pipeline TEXT NOT NULL, current_step TEXT, priority INTEGER NOT NULL DEFAULT 5,
  branch TEXT, worktree TEXT, feature_dir TEXT, ticket TEXT, qa_cycles INTEGER NOT NULL DEFAULT 0,
  plan_cycles INTEGER NOT NULL DEFAULT 0, rejection TEXT, result TEXT, pr_url TEXT, superseded_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
  session_id TEXT, resume_prompt TEXT, workspace_id TEXT, tab_id TEXT, pane_id TEXT, machine TEXT,
  started_at TEXT, finished_at TEXT, lease_until TEXT, result TEXT, error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, timeout_min INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, task_id TEXT, step_id INTEGER, type TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE resource_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, machine TEXT NOT NULL, resource TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id), step_id INTEGER NOT NULL REFERENCES steps(id), reason TEXT,
  requested_at TEXT NOT NULL, granted_at TEXT, overdue_at TEXT, expect_min INTEGER,
  UNIQUE (project, machine, resource, step_id)
);
`;

const S37 = "7096e737-5abe-4a4a-9f4b-885704b19739";
const S39 = "ff61d3a8-2553-46a8-9bb7-74f7e52ecce7";
// Real rows from the live DB (ids, session ids, costs, turns); briefs are placeholders.
const ROWS: [number, string, string, number, string | null, number, number][] = [
  [364, "T0037", "implement", 1, S37, 7.8419594, 5],
  [370, "T0037", "implement", 2, S37, 19.16098, 10],
  [376, "T0037", "implement", 3, S37, 21.5487856, 35],
  [393, "T0037", "implement", 4, S37, 22.823075, 3],
  [401, "T0037", "implement", 5, S37, 27.1355076, 70],
  [406, "T0037", "implement", 6, S37, 29.8833934, 46],
  [416, "T0037", "implement", 7, "3e6d6ab7-dbb6-44fb-b918-36a47061d29b", 6.7740779, 146],
  [437, "T0037", "implement", 8, "36ab8c0b-132e-486c-bb63-3b60d0e1a42b", 3.73644, 66],
  [441, "T0039", "implement", 1, "4172aee2-652f-4d7c-8f5c-4a500eff6654", 11.3648898, 168],
  [456, "T0039", "implement", 2, S39, 0, 0],
  [463, "T0039", "implement", 3, S39, 5.7770938, 27],
  [470, "T0039", "handoff", 1, null, 0.5, 3],
];

function oldDb(): string {
  const path = join(tmp("db"), "old.db");
  const db = new Database(path, { create: true });
  db.exec(OLD_SCHEMA);
  const ts = "2026-11-04T10:00:00.000Z";
  for (const id of ["T0037", "T0039"])
    db.run("INSERT INTO tasks (id, project, kind, title, brief, status, pipeline, created_at, updated_at) VALUES (?, 'foreman', 'feature', ?, 'placeholder', 'done', '[]', ?, ?)", [id, id, ts, ts]);
  for (const [id, task, name, attempt, sid, cost, turns] of ROWS)
    db.run("INSERT INTO steps (id, task_id, name, role, status, attempt, session_id, cost_usd, turns, finished_at, created_at) VALUES (?, ?, ?, 'developer', 'done', ?, ?, ?, ?, ?, ?)",
      [id, task, name, attempt, sid, cost, turns, ts, ts]);
  db.close();
  return path;
}

const snapshot = (s: InstanceType<typeof Store>) =>
  s.db.query("SELECT id, cost_usd, session_cost_usd, turns, cost_estimated, cost_unknown FROM steps ORDER BY id").all();

test("AS-9: history migrates to per-attempt deltas, raw values kept, idempotent", () => {
  const path = oldDb();
  const store = new Store(path);
  const cost = (id: number) => store.getStep(id)!.cost_usd;
  expect([364, 370, 376, 393, 401, 406].map(id => cost(id).toFixed(2))).toEqual(["7.84", "11.32", "2.39", "1.27", "4.31", "2.75"]);
  expect([364, 370, 376, 393, 401, 406].reduce((a, id) => a + cost(id), 0)).toBeCloseTo(29.8833934, 6);
  expect(cost(456)).toBe(0);
  expect(cost(463)).toBeCloseTo(5.7770938, 9);
  for (const [id, , , , , old, turns] of ROWS) {
    const st = store.getStep(id)!;
    expect(st.session_cost_usd).toBe(old);
    expect(st.turns).toBe(turns);
    expect(st.cost_estimated).toBe(0);
    expect(st.cost_unknown).toBe(0);
  }
  for (const id of [416, 437, 441, 470]) expect(cost(id)).toBe(ROWS.find(r => r[0] === id)![5]);
  const ev = store.db.query("SELECT data FROM events WHERE type = 'costs.migrated'").all() as { data: string }[];
  expect(ev.length).toBe(1);
  const data = JSON.parse(ev[0].data);
  expect(data.sessions).toBe(2);
  expect(data.rows).toBe(5);
  expect(data.before).toBeCloseTo(ROWS.reduce((a, r) => a + r[5], 0), 6);
  expect(data.after).toBeCloseTo(29.8833934 + 6.7740779 + 3.73644 + 11.3648898 + 5.7770938 + 0.5, 6);
  const first = snapshot(store);
  store.db.close();

  const again = new Store(path);
  expect(snapshot(again)).toEqual(first);
  expect((again.db.query("SELECT COUNT(*) c FROM events WHERE type = 'costs.migrated'").get() as { c: number }).c).toBe(1);
  again.db.close();
});

test("a fresh database gets the columns and records the migration as done", () => {
  const store = new Store(join(tmp("fresh"), "new.db"));
  const cols = (store.db.query("PRAGMA table_info(steps)").all() as { name: string }[]).map(c => c.name);
  expect(cols).toContain("session_cost_usd");
  expect(cols).toContain("cost_estimated");
  expect(cols).toContain("cost_unknown");
  expect(store.db.query("SELECT 1 FROM meta WHERE key = 'migration:cost_deltas_v1'").get()).toBeTruthy();
  store.db.close();
});
