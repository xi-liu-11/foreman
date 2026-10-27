// SQLite store. `events` is append-only and is the audit trail; the other
// tables are the materialised current state the scheduler and CLI query.
import { Database } from "bun:sqlite";
import { DB_PATH, ensureHome } from "./config";

export type TaskStatus = "queued" | "running" | "blocked" | "gate" | "done" | "failed" | "cancelled";
export type StepStatus = "pending" | "queued" | "running" | "blocked" | "gate" | "done" | "failed" | "skipped";

export interface TaskRow {
  id: string;
  project: string;
  kind: string;
  title: string;
  brief: string;
  status: TaskStatus;
  pipeline: string;      // JSON PipelineStep[]
  current_step: string | null;
  priority: number;
  branch: string | null;
  worktree: string | null;
  feature_dir: string | null;
  ticket: string | null;
  qa_cycles: number;
  result: string | null;  // JSON final summary
  created_at: string;
  updated_at: string;
}

export interface StepRow {
  id: number;
  task_id: string;
  name: string;
  role: string;
  status: StepStatus;
  attempt: number;
  session_id: string | null;
  resume_prompt: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  machine: string | null;
  started_at: string | null;
  finished_at: string | null;
  lease_until: string | null;
  result: string | null;   // JSON structured output from the worker
  error: string | null;
  cost_usd: number;
  turns: number;
  created_at: string;
}

export interface BlockRow {
  id: number;
  task_id: string;
  step_id: number;
  question: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface ArtifactRow {
  id: number;
  task_id: string;
  step_id: number | null;
  path: string;
  kind: string;
  note: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  ts: string;
  task_id: string | null;
  step_id: number | null;
  type: string;
  data: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  current_step TEXT,
  priority INTEGER NOT NULL DEFAULT 5,
  branch TEXT, worktree TEXT, feature_dir TEXT, ticket TEXT,
  qa_cycles INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL, role TEXT NOT NULL,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
  session_id TEXT, resume_prompt TEXT,
  workspace_id TEXT, tab_id TEXT, pane_id TEXT, machine TEXT,
  started_at TEXT, finished_at TEXT, lease_until TEXT,
  result TEXT, error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_task ON steps(task_id, name);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id INTEGER NOT NULL REFERENCES steps(id),
  question TEXT NOT NULL, answer TEXT,
  created_at TEXT NOT NULL, answered_at TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id INTEGER,
  path TEXT NOT NULL, kind TEXT NOT NULL, note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id TEXT, step_id INTEGER,
  type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
`;

export const now = () => new Date().toISOString();

export class Store {
  db: Database;
  constructor(path: string = DB_PATH) {
    ensureHome();
    this.db = new Database(path, { create: true });
    this.db.exec(SCHEMA);
  }

  event(type: string, data: Record<string, unknown> = {}, task_id: string | null = null, step_id: number | null = null): void {
    this.db.run("INSERT INTO events (ts, task_id, step_id, type, data) VALUES (?, ?, ?, ?, ?)",
      [now(), task_id, step_id, type, JSON.stringify(data)]);
  }

  nextTaskId(): string {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'task_seq'").get() as { value: string } | null;
    const n = (row ? Number(row.value) : 0) + 1;
    this.db.run("INSERT INTO meta (key, value) VALUES ('task_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(n)]);
    return "T" + String(n).padStart(4, "0");
  }

  // Per-project monotonic feature number, so parallel Spec Kit features never collide.
  nextFeatureNumber(project: string, floor: number): number {
    const key = `feature_seq:${project}`;
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    const n = Math.max(row ? Number(row.value) : 0, floor) + 1;
    this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(n)]);
    return n;
  }

  // --- tasks ---
  getTask(id: string): TaskRow | null {
    return this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
  }
  listTasks(filter: { status?: string[]; project?: string; all?: boolean } = {}): TaskRow[] {
    const where: string[] = []; const args: any[] = [];
    if (filter.status?.length) { where.push(`status IN (${filter.status.map(() => "?").join(",")})`); args.push(...filter.status); }
    else if (!filter.all) { where.push("status NOT IN ('done','failed','cancelled')"); }
    if (filter.project) { where.push("project = ?"); args.push(filter.project); }
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY priority ASC, created_at ASC`;
    return this.db.query(sql).all(...args) as TaskRow[];
  }
  insertTask(t: Omit<TaskRow, "created_at" | "updated_at">): TaskRow {
    const ts = now();
    this.db.run(`INSERT INTO tasks (id, project, kind, title, brief, status, pipeline, current_step, priority, branch, worktree, feature_dir, ticket, qa_cycles, result, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.project, t.kind, t.title, t.brief, t.status, t.pipeline, t.current_step, t.priority, t.branch, t.worktree, t.feature_dir, t.ticket, t.qa_cycles, t.result, ts, ts]);
    return this.getTask(t.id)!;
  }
  updateTask(id: string, patch: Partial<TaskRow>): void {
    const keys = Object.keys(patch).filter(k => k !== "id");
    if (!keys.length) return;
    const sets = keys.map(k => `${k} = ?`).join(", ");
    this.db.run(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`, [...keys.map(k => (patch as any)[k]), now(), id]);
  }

  // --- steps ---
  getStep(id: number): StepRow | null {
    return this.db.query("SELECT * FROM steps WHERE id = ?").get(id) as StepRow | null;
  }
  stepsForTask(task_id: string): StepRow[] {
    return this.db.query("SELECT * FROM steps WHERE task_id = ? ORDER BY id ASC").all(task_id) as StepRow[];
  }
  latestStep(task_id: string, name: string): StepRow | null {
    return this.db.query("SELECT * FROM steps WHERE task_id = ? AND name = ? ORDER BY id DESC LIMIT 1").get(task_id, name) as StepRow | null;
  }
  insertStep(s: { task_id: string; name: string; role: string; status: StepStatus; attempt: number; session_id?: string | null; resume_prompt?: string | null; machine?: string | null }): StepRow {
    const r = this.db.run(`INSERT INTO steps (task_id, name, role, status, attempt, session_id, resume_prompt, machine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.task_id, s.name, s.role, s.status, s.attempt, s.session_id ?? null, s.resume_prompt ?? null, s.machine ?? null, now()]);
    return this.getStep(Number(r.lastInsertRowid))!;
  }
  updateStep(id: number, patch: Partial<StepRow>): void {
    const keys = Object.keys(patch).filter(k => k !== "id");
    if (!keys.length) return;
    const sets = keys.map(k => `${k} = ?`).join(", ");
    this.db.run(`UPDATE steps SET ${sets} WHERE id = ?`, [...keys.map(k => (patch as any)[k]), id]);
  }
  runningSteps(): StepRow[] {
    return this.db.query("SELECT * FROM steps WHERE status = 'running'").all() as StepRow[];
  }
  runningCount(project?: string): number {
    if (project) return (this.db.query("SELECT COUNT(*) c FROM steps s JOIN tasks t ON t.id = s.task_id WHERE s.status = 'running' AND t.project = ?").get(project) as any).c;
    return (this.db.query("SELECT COUNT(*) c FROM steps WHERE status = 'running'").get() as any).c;
  }

  // --- blocks ---
  insertBlock(task_id: string, step_id: number, question: string): BlockRow {
    const r = this.db.run("INSERT INTO blocks (task_id, step_id, question, created_at) VALUES (?, ?, ?, ?)", [task_id, step_id, question, now()]);
    return this.db.query("SELECT * FROM blocks WHERE id = ?").get(Number(r.lastInsertRowid)) as BlockRow;
  }
  getBlock(id: number): BlockRow | null {
    return this.db.query("SELECT * FROM blocks WHERE id = ?").get(id) as BlockRow | null;
  }
  openBlocks(task_id?: string): BlockRow[] {
    if (task_id) return this.db.query("SELECT * FROM blocks WHERE answer IS NULL AND task_id = ? ORDER BY id").all(task_id) as BlockRow[];
    return this.db.query("SELECT * FROM blocks WHERE answer IS NULL ORDER BY id").all() as BlockRow[];
  }
  blocksForStep(step_id: number): BlockRow[] {
    return this.db.query("SELECT * FROM blocks WHERE step_id = ? ORDER BY id").all(step_id) as BlockRow[];
  }
  answerBlock(id: number, answer: string): void {
    this.db.run("UPDATE blocks SET answer = ?, answered_at = ? WHERE id = ?", [answer, now(), id]);
  }

  // --- artifacts ---
  insertArtifact(task_id: string, step_id: number | null, path: string, kind: string, note: string | null): ArtifactRow {
    const r = this.db.run("INSERT INTO artifacts (task_id, step_id, path, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?)", [task_id, step_id, path, kind, note, now()]);
    return this.db.query("SELECT * FROM artifacts WHERE id = ?").get(Number(r.lastInsertRowid)) as ArtifactRow;
  }
  artifactsForTask(task_id: string): ArtifactRow[] {
    return this.db.query("SELECT * FROM artifacts WHERE task_id = ? ORDER BY id").all(task_id) as ArtifactRow[];
  }

  eventsForTask(task_id: string, limit = 200): EventRow[] {
    return this.db.query("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(task_id, limit) as EventRow[];
  }
}
