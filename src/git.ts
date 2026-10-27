// Git, worktree, Spec Kit feature, and PR operations performed by the scheduler.
// Workers never push, open PRs, or merge; the deny list stops them and these
// helpers do it after the human gates instead.
import { join, basename } from "node:path";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
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
export async function setupWorktree(cfg: ForemanConfig, proj: ProjectConfig, task_id: string, title: string, featureNumber: number | null): Promise<WorktreeInfo> {
  const repo = proj.path;
  await must([gitBin(), "rev-parse", "--git-dir"], repo, `${proj.name} is not a git repository`);
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

export async function mergePr(proj: ProjectConfig, worktree: string, prUrl: string): Promise<string> {
  const out = await must([ghBin(), "pr", "merge", prUrl, "--squash", "--delete-branch"], worktree, "gh pr merge");
  return out;
}
