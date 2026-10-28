// Git, worktree, Spec Kit feature, and PR operations performed by the scheduler.
// Workers never push, open PRs, or merge; the deny list stops them and these
// helpers do it after the human gates instead.
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { expandHome, type ProjectConfig, type ForemanConfig } from "./config";

export interface ExecResult { code: number; out: string; err: string }

export async function exec(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

export async function must(cmd: string[], cwd: string, what: string): Promise<string> {
  const r = await exec(cmd, cwd);
  if (r.code !== 0) throw new Error(`${what}: ${r.err || r.out || `exit ${r.code}`}`);
  return r.out;
}

const gitBin = () => process.env.FOREMAN_GIT_BIN ?? "git";
const ghBin = () => process.env.FOREMAN_GH_BIN ?? "gh";

export function shortName(title: string, maxWords = 4): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(w => !["a", "an", "the", "to", "for", "of", "and", "in", "on", "with"].includes(w));
  return (words.slice(0, maxWords).join("-") || "feature").slice(0, 40).replace(/-+$/, "");
}

// Highest Spec Kit feature number visible in branches and specs/ (mirrors create-new-feature.sh).
export async function highestFeatureNumber(repo: string): Promise<number> {
  let max = 0;
  const branches = await exec([gitBin(), "branch", "-a", "--format=%(refname:short)"], repo);
  for (const b of branches.out.split("\n")) { const m = basename(b.trim()).match(/^(\d{3})-/); if (m) max = Math.max(max, Number(m[1])); }
  const specs = join(repo, "specs");
  if (existsSync(specs)) for (const d of readdirSync(specs)) { const m = d.match(/^(\d{3})-/); if (m) max = Math.max(max, Number(m[1])); }
  return max;
}

export interface WorktreeInfo { branch: string; worktree: string; feature_dir: string }

// Create the branch and worktree for a task. For Spec Kit projects also create
// specs/<NNN-name>/spec.md from the template so the specify worker can skip the
// script (which would try `git checkout -b` in the main checkout).
export async function setupWorktree(cfg: ForemanConfig, proj: ProjectConfig, task_id: string, title: string, featureNumber: number | null, existingBranch: string | null = null): Promise<WorktreeInfo> {
  const repo = proj.path;
  await must([gitBin(), "rev-parse", "--git-dir"], repo, `${proj.name} is not a git repository`);
  if (existingBranch) return attachWorktree(cfg, proj, task_id, title, existingBranch);
  const base = proj.base_branch;
  const baseOk = await exec([gitBin(), "rev-parse", "--verify", "--quiet", base], repo);
  if (baseOk.code !== 0) throw new Error(`base branch '${base}' does not exist in ${repo}`);
  // Best effort: bring the base up to date if it tracks a remote.
  const upstream = await exec([gitBin(), "rev-parse", "--abbrev-ref", `${base}@{upstream}`], repo);
  if (upstream.code === 0) {
    const f = await exec([gitBin(), "fetch", "--quiet", upstream.out.split("/")[0]], repo);
    if (f.code === 0) await exec([gitBin(), "branch", "-f", "--quiet", base, upstream.out], repo).catch(() => {});
  }

  const name = shortName(title);
  const branch = featureNumber !== null ? `${String(featureNumber).padStart(3, "0")}-${name}` : `fm/${task_id.toLowerCase()}-${name}`;
  const root = join(expandHome(cfg.defaults.worktrees), proj.name);
  mkdirSync(root, { recursive: true });
  const worktree = join(root, branch.replace("/", "-"));
  if (existsSync(worktree)) throw new Error(`worktree path already exists: ${worktree}`);
  await must([gitBin(), "worktree", "add", "-b", branch, worktree, base], repo, "git worktree add");

  const feature_dir = featureNumber !== null ? `specs/${branch}` : `specs/${task_id.toLowerCase()}-${name}`;
  const dir = join(worktree, feature_dir);
  mkdirSync(dir, { recursive: true });
  const template = join(worktree, ".specify", "templates", "spec-template.md");
  const spec = join(dir, "spec.md");
  if (featureNumber !== null && existsSync(template)) copyFileSync(template, spec);
  else if (!existsSync(spec)) writeFileSync(spec, `# ${title}\n\n_Created by Foreman ${task_id}._\n`);
  return { branch, worktree, feature_dir };
}

// Attach a task to a branch that already exists (for example a feature whose
// spec and plan were written by hand). The branch must not be checked out anywhere.
async function attachWorktree(cfg: ForemanConfig, proj: ProjectConfig, task_id: string, title: string, branch: string): Promise<WorktreeInfo> {
  const repo = proj.path;
  const ok = await exec([gitBin(), "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
  if (ok.code !== 0) throw new Error(`branch '${branch}' does not exist in ${repo}`);
  const list = (await must([gitBin(), "worktree", "list", "--porcelain"], repo, "git worktree list")).split("\n\n");
  const holder = list.find(block => block.includes(`branch refs/heads/${branch}\n`) || block.endsWith(`branch refs/heads/${branch}`));
  const holderPath = holder?.split("\n")[0].replace(/^worktree /, "") ?? null;
  const root = join(expandHome(cfg.defaults.worktrees), proj.name);
  mkdirSync(root, { recursive: true });
  const worktree = join(root, branch.replace("/", "-"));
  if (holderPath && holderPath === worktree) {
    // The user already made the worktree where Foreman would put it: adopt it as long as it is clean.
    if (!(await isClean(worktree))) throw new Error(`worktree ${worktree} has uncommitted changes; commit or stash them first`);
  } else {
    if (holderPath) throw new Error(`branch '${branch}' is checked out at ${holderPath}; switch that checkout to another branch first`);
    if (existsSync(worktree)) throw new Error(`worktree path already exists: ${worktree}`);
    await must([gitBin(), "worktree", "add", worktree, branch], repo, "git worktree add");
  }
  const feature_dir = existsSync(join(worktree, "specs", branch)) ? `specs/${branch}` : `specs/${task_id.toLowerCase()}-${shortName(title)}`;
  mkdirSync(join(worktree, feature_dir), { recursive: true });
  return { branch, worktree, feature_dir };
}

export async function removeWorktree(proj: ProjectConfig, worktree: string): Promise<void> {
  if (!existsSync(worktree)) return;
  await exec([gitBin(), "worktree", "remove", "--force", worktree], proj.path);
}

export async function isClean(worktree: string): Promise<boolean> {
  return (await must([gitBin(), "status", "--porcelain"], worktree, "git status")) === "";
}

export async function pushAndOpenPr(proj: ProjectConfig, worktree: string, branch: string, title: string, bodyFile: string | null): Promise<string> {
  if (!(await isClean(worktree))) throw new Error("worktree has uncommitted changes; the pr step must commit everything");
  const remote = await exec([gitBin(), "remote", "get-url", "origin"], worktree);
  if (remote.code !== 0) throw new Error(`no 'origin' remote in ${proj.name}; add one before using the implement pipeline`);
  await must([gitBin(), "push", "--quiet", "-u", "origin", branch], worktree, "git push");
  const existing = await exec([ghBin(), "pr", "view", branch, "--json", "url", "-q", ".url"], worktree);
  if (existing.code === 0 && existing.out.startsWith("http")) return existing.out;
  const args = [ghBin(), "pr", "create", "--base", proj.base_branch, "--head", branch, "--title", title];
  if (bodyFile && existsSync(bodyFile)) args.push("--body-file", bodyFile); else args.push("--body", `Opened by Foreman for ${branch}.`);
  const out = await must(args, worktree, "gh pr create");
  const url = out.split("\n").find(l => l.startsWith("http")) ?? out;
  return url;
}

// Direct mode: rebase the branch on the base, then either squash it into one
// commit or merge it with --no-ff (in a temporary detached worktree), push the
// result to the base branch, and fast-forward the main checkout if it is on the
// base. The user's main checkout is never left mid-merge.
export async function mergeDirect(proj: ProjectConfig, worktree: string, branch: string, message: string, squash: boolean): Promise<string> {
  if (!(await isClean(worktree))) throw new Error("worktree has uncommitted changes; the last step must commit everything");
  const hasOrigin = (await exec([gitBin(), "remote", "get-url", "origin"], worktree)).code === 0;
  const baseRef = hasOrigin ? `origin/${proj.base_branch}` : proj.base_branch;
  if (hasOrigin) await must([gitBin(), "fetch", "--quiet", "origin", proj.base_branch], worktree, "git fetch");
  const rebase = await exec([gitBin(), "rebase", baseRef], worktree);
  if (rebase.code !== 0) { await exec([gitBin(), "rebase", "--abort"], worktree); throw new Error(`rebase onto ${baseRef} has conflicts; resolve in ${worktree} and run task retry`); }
  const changed = (await must([gitBin(), "rev-list", "--count", `${baseRef}..HEAD`], worktree, "git rev-list")).trim();
  if (changed === "0") throw new Error(`branch ${branch} has no commits beyond ${baseRef}`);
  let sha: string;
  let how: string;
  if (squash) {
    await must([gitBin(), "reset", "--quiet", "--soft", baseRef], worktree, "git reset --soft");
    await must([gitBin(), "commit", "--quiet", "-m", message], worktree, "git commit");
    sha = (await must([gitBin(), "rev-parse", "HEAD"], worktree, "git rev-parse")).trim();
    how = "squashed onto";
  } else {
    const tmp = join(dirname(worktree), `_merge-${proj.name}-${Date.now()}`);
    await must([gitBin(), "worktree", "add", "--quiet", "--detach", tmp, baseRef], proj.path, "git worktree add (merge)");
    try {
      await must([gitBin(), "merge", "--no-ff", "--quiet", "-m", message, branch], tmp, "git merge --no-ff");
      sha = (await must([gitBin(), "rev-parse", "HEAD"], tmp, "git rev-parse")).trim();
    } finally { await exec([gitBin(), "worktree", "remove", "--force", tmp], proj.path); }
    how = "merged (no-ff) into";
  }
  if (hasOrigin) {
    await must([gitBin(), "push", "--quiet", "origin", `${sha}:refs/heads/${proj.base_branch}`], worktree, "git push");
    await exec([gitBin(), "fetch", "--quiet", "origin"], proj.path);
  }
  // Keep the main checkout current when it is sitting on the base branch.
  const current = (await exec([gitBin(), "rev-parse", "--abbrev-ref", "HEAD"], proj.path)).out.trim();
  let note = "";
  if (current === proj.base_branch) {
    const ff = await exec([gitBin(), "merge", "--ff-only", "--quiet", sha], proj.path);
    note = ff.code === 0 ? "; main checkout fast-forwarded" : `; main checkout not updated (${ff.err.trim().split("\n").pop()})`;
  } else if (!hasOrigin) {
    await must([gitBin(), "update-ref", `refs/heads/${proj.base_branch}`, sha], proj.path, "git update-ref");
  }
  return `${sha.slice(0, 7)} ${how} ${proj.base_branch}${hasOrigin ? " and pushed" : ""}${note}`;
}

// Claude Code keys its auto-memory by working directory, so a worktree would
// start with empty memory. Point the worktree's memory directory at the main
// checkout's so workers read (and add to) the project's accumulated knowledge.
export function linkClaudeMemory(mainPath: string, worktree: string): string | null {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const key = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
  const mainMem = join(projects, key(mainPath), "memory");
  const wtDir = join(projects, key(worktree));
  const wtMem = join(wtDir, "memory");
  try {
    mkdirSync(mainMem, { recursive: true });
    mkdirSync(wtDir, { recursive: true });
    if (!existsSync(wtMem)) symlinkSync(mainMem, wtMem);
    return wtMem;
  } catch { return null; }
}

export async function deleteBranch(proj: ProjectConfig, branch: string): Promise<void> {
  await exec([gitBin(), "branch", "-D", branch], proj.path);
}

export async function mergePr(proj: ProjectConfig, worktree: string, prUrl: string): Promise<string> {
  const out = await must([ghBin(), "pr", "merge", prUrl, "--squash", "--delete-branch"], worktree, "gh pr merge");
  return out;
}
