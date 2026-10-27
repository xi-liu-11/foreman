// Thin wrapper over the herdr CLI. Foreman uses herdr only as the place where
// worker processes run and can be watched; all state lives in the task DB.
export interface HerdrPane { workspace_id: string; tab_id: string; pane_id: string }

function herdrArgs(machine?: string | null): string[] {
  return machine ? ["herdr", "--machine", machine] : ["herdr"];
}

async function run(args: string[]): Promise<any> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}): ${err.trim() || out.trim()}`);
  try { return JSON.parse(out); } catch { return out; }
}

export async function herdrAvailable(machine?: string | null): Promise<boolean> {
  try {
    const r = await run([...herdrArgs(machine), "workspace", "list"]);
    return Boolean(r?.result?.workspaces);
  } catch { return false; }
}

export async function findWorkspace(label: string, machine?: string | null): Promise<string | null> {
  const r = await run([...herdrArgs(machine), "workspace", "list"]);
  const ws = (r?.result?.workspaces ?? []).find((w: any) => w.label === label);
  return ws?.workspace_id ?? null;
}

export async function ensureWorkspace(label: string, cwd: string, machine?: string | null): Promise<string> {
  const existing = await findWorkspace(label, machine);
  if (existing) return existing;
  const r = await run([...herdrArgs(machine), "workspace", "create", "--label", label, "--cwd", cwd, "--no-focus"]);
  const id = r?.result?.workspace?.workspace_id ?? r?.result?.workspace?.id;
  if (!id) throw new Error(`workspace create returned no id: ${JSON.stringify(r)}`);
  return id;
}

// Create a tab in a workspace and run a command in its root pane.
export async function launchInTab(opts: {
  workspace_id: string; label: string; cwd: string; env: Record<string, string>; command: string[]; machine?: string | null;
}): Promise<HerdrPane> {
  const args = [...herdrArgs(opts.machine), "tab", "create", "--workspace", opts.workspace_id, "--cwd", opts.cwd, "--label", opts.label, "--no-focus"];
  for (const [k, v] of Object.entries(opts.env)) args.push("--env", `${k}=${v}`);
  const r = await run(args);
  const tab_id = r?.result?.tab?.tab_id ?? r?.result?.tab?.id;
  const pane_id = r?.result?.root_pane?.pane_id ?? r?.result?.root_pane?.id;
  if (!tab_id || !pane_id) throw new Error(`tab create returned no ids: ${JSON.stringify(r)}`);
  await run([...herdrArgs(opts.machine), "pane", "run", pane_id, ...opts.command]);
  return { workspace_id: opts.workspace_id, tab_id, pane_id };
}

export async function closeTab(tab_id: string, machine?: string | null): Promise<void> {
  try { await run([...herdrArgs(machine), "tab", "close", tab_id]); } catch { /* already gone */ }
}

export async function notify(title: string, body: string, sound: "none" | "done" | "request" = "none"): Promise<void> {
  try { await run(["herdr", "notification", "show", title, "--body", body, "--sound", sound]); } catch { /* not in herdr */ }
}
