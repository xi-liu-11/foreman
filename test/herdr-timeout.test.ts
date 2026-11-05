import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchInTab, ensureWorkspace, setTimeoutSec } from "../src/herdr";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "fm-herdr-timeout-")));
const log = join(dir, "calls.log");
const WS = '{"result":{"workspaces":[{"label":"fm:x","workspace_id":"w1"}]}}';
const TAB = '{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}';
// Behaviour is selected per test via HERDR_STUB_MODE; every call is logged.
writeFileSync(join(dir, "herdr"), `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2:$HERDR_STUB_MODE" in
  "tab create:hang-tab") exec sleep 5 ;;
  "workspace list:hang-ws") exec sleep 5 ;;
  "workspace list:"*) echo '${WS}' ;;
  "tab create:"*) echo '${TAB}' ;;
  "pane run:pane-fails") echo boom >&2; exit 1 ;;
  *) echo '{}' ;;
esac
`);
chmodSync(join(dir, "herdr"), 0o755);
const savedPath = process.env.PATH;
const savedMode = process.env.HERDR_STUB_MODE;
process.env.PATH = `${dir}:${savedPath}`;
setTimeoutSec(1);
afterAll(() => {
  setTimeoutSec(120);
  process.env.PATH = savedPath;
  if (savedMode === undefined) delete process.env.HERDR_STUB_MODE; else process.env.HERDR_STUB_MODE = savedMode;
});

const opts = { workspace_id: "w1", label: "l", cwd: dir, env: { A: "b" }, command: ["echo", "hi"] };
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

test("a hanging tab create rejects with a timeout error within ~3s", async () => {
  process.env.HERDR_STUB_MODE = "hang-tab";
  const t0 = Date.now();
  await expect(launchInTab(opts)).rejects.toThrow("herdr tab create timed out after 1s");
  expect(Date.now() - t0).toBeLessThan(3000);
});

test("a failing pane run closes the tab before rethrowing", async () => {
  process.env.HERDR_STUB_MODE = "pane-fails";
  writeFileSync(log, "");
  await expect(launchInTab(opts)).rejects.toThrow(/pane run .* failed \(1\)/);
  const c = calls();
  expect(c.some(l => l.startsWith("tab create"))).toBe(true);
  expect(c.some(l => l.startsWith("pane run p1"))).toBe(true);
  expect(c).toContain("tab close t1");
  expect(c.indexOf("tab close t1")).toBeGreaterThan(c.findIndex(l => l.startsWith("pane run")));
});

test("ensureWorkspace with a hanging workspace list times out", async () => {
  process.env.HERDR_STUB_MODE = "hang-ws";
  const t0 = Date.now();
  await expect(ensureWorkspace("fm:x", dir)).rejects.toThrow("herdr workspace list timed out after 1s");
  expect(Date.now() - t0).toBeLessThan(3000);
});

test("healthy stub still works", async () => {
  process.env.HERDR_STUB_MODE = "ok";
  expect(await ensureWorkspace("fm:x", dir)).toBe("w1");
  expect(await launchInTab(opts)).toEqual({ workspace_id: "w1", tab_id: "t1", pane_id: "p1" });
});
