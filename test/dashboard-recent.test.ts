import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

type T = { id: string; status: string; created_at: string; updated_at?: string };
const html = readFileSync(join(import.meta.dir, "../src/dashboard.html"), "utf8");
const line = html.split("\n").find(l => l.startsWith("const recentTasks = "))!;
const recentTasks = new Function(`${line}\nreturn recentTasks;`)() as (tasks: T[], exclude?: T[]) => T[];
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

test("recentTasks: newest finished first, active tasks excluded", () => {
  const all: T[] = [
    { id: "A", status: "done", created_at: ago(200), updated_at: ago(72) },
    { id: "R", status: "running", created_at: ago(300), updated_at: ago(0.1) },
    { id: "B", status: "failed", created_at: ago(100), updated_at: ago(1) },
    { id: "C", status: "cancelled", created_at: ago(400), updated_at: ago(48) },
  ];
  expect(recentTasks(all).map(t => t.id)).toEqual(["B", "C", "A"]);
  expect(all.map(t => t.id)).toEqual(["A", "R", "B", "C"]);
});

test("recentTasks: caps at the 15 newest", () => {
  const all: T[] = Array.from({ length: 20 }, (_, i) => ({ id: `T${i}`, status: "done", created_at: ago(500), updated_at: ago(i) }));
  const r = recentTasks(all);
  expect(r.length).toBe(15);
  expect(r.map(t => t.id)).toEqual(Array.from({ length: 15 }, (_, i) => `T${i}`));
});

test("recentTasks: falls back to created_at without updated_at", () => {
  const all: T[] = [
    { id: "old", status: "superseded", created_at: ago(10) },
    { id: "new", status: "done", created_at: ago(2) },
    { id: "mid", status: "done", created_at: ago(50), updated_at: ago(5) },
  ];
  expect(recentTasks(all).map(t => t.id)).toEqual(["new", "mid", "old"]);
});

test("recentTasks: excluded (Needs you) tasks are not repeated", () => {
  const f: T = { id: "F", status: "failed", created_at: ago(5), updated_at: ago(1) };
  const d: T = { id: "D", status: "done", created_at: ago(5), updated_at: ago(2) };
  expect(recentTasks([f, d], [f]).map(t => t.id)).toEqual(["D"]);
});
