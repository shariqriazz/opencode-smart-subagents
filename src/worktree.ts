import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface WorktreeInfo {
  /** The checkout the child's changes go back to. */
  repoRoot: string;
  path: string;
  branch: string;
  /** Commit the worktree started from. */
  baseCommit: string;
  projectID: string;
}

export const WORKTREE_ACTIONS = ["inspect", "patch", "cherry-pick", "merge", "discard"] as const;
export type WorktreeAction = (typeof WORKTREE_ACTIONS)[number];

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const COMMIT_IDENTITY = ["-c", "user.name=OpenCode Subagent", "-c", "user.email=opencode-subagent@localhost"];

function exec(args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile("git", args, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) });
    });
  });
}

async function git(args: string[]): Promise<string> {
  const result = await exec(args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);

/** The repository root of `directory`, after checking that it has no uncommitted or untracked changes. */
export async function cleanRepoRoot(directory: string): Promise<string> {
  const repoRoot = await git(["-C", directory, "rev-parse", "--show-toplevel"]);
  const status = await git(["-C", repoRoot, "status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new Error(
      "Worktree isolation needs a clean checkout, because the worktree starts from HEAD and would miss uncommitted changes. Commit or stash them, or run the child without isolation.",
    );
  }
  return repoRoot;
}

/** Records the starting commit of a worktree OpenCode just created, giving a detached worktree its own branch so its commits can be cherry-picked or merged. */
export async function describeWorktree(repoRoot: string, directory: string, projectID: string): Promise<WorktreeInfo> {
  let branch = await git(["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    branch = `opencode-subagent/${path.basename(directory)}`;
    await git(["-C", directory, "switch", "-c", branch]);
  }
  const baseCommit = await git(["-C", directory, "rev-parse", "HEAD"]);
  return { repoRoot, path: directory, branch, baseCommit, projectID };
}

export async function inspectWorktree(info: WorktreeInfo) {
  const status = await git(["-C", info.path, "status", "--porcelain", "--untracked-files=all"]);
  const changed = lines(await git(["-C", info.path, "diff", "--name-only", info.baseCommit]));
  const untracked = lines(status).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
  const commits = info.branch === "HEAD" ? [] : lines(await git(["-C", info.repoRoot, "rev-list", "--reverse", `${info.baseCommit}..${info.branch}`]));
  return { dirty: !!status, files: [...new Set([...changed, ...untracked])], commits };
}

/** Applies every change since the worktree's starting commit, committed or not, to the source checkout as a patch. */
export async function patchWorktree(info: WorktreeInfo) {
  await git(["-C", info.path, "add", "-N", "--", "."]);
  const diff = await exec(["-C", info.path, "diff", "--binary", info.baseCommit]);
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  if (!diff.stdout.trim()) return { changed: false, files: [] as string[] };
  const files = lines(await git(["-C", info.path, "diff", "--name-only", info.baseCommit]));
  const patchFile = path.join(os.tmpdir(), `opencode-subagent-${randomUUID()}.patch`);
  await fs.writeFile(patchFile, diff.stdout, { mode: 0o600 });
  try {
    await git(["-C", info.repoRoot, "apply", "--check", "--whitespace=nowarn", patchFile]);
    await git(["-C", info.repoRoot, "apply", "--whitespace=nowarn", patchFile]);
  } finally {
    await fs.rm(patchFile, { force: true });
  }
  return { changed: true, files };
}

/** Cherry-picks or merges the worktree's commits after a preflight in a temporary worktree. */
export async function integrateWorktree(info: WorktreeInfo, action: "cherry-pick" | "merge", label: string) {
  if (await git(["-C", info.repoRoot, "status", "--porcelain"])) {
    throw new Error("The source checkout must be clean for cherry-pick or merge. Use action patch to keep unrelated working-tree changes.");
  }
  if (info.branch === "HEAD") throw new Error("The worktree has a detached HEAD, so it has no branch to integrate. Use action patch.");
  if (await git(["-C", info.path, "status", "--porcelain"])) {
    await git(["-C", info.path, "add", "-A", "--", "."]);
    await git(["-C", info.path, ...COMMIT_IDENTITY, "commit", "-m", `Apply subagent changes: ${label}`]);
  }
  const inspected = await inspectWorktree(info);
  if (inspected.commits.length === 0) return { changed: false, files: inspected.files, commits: [] as string[] };
  const args = action === "merge" ? ["merge", "--no-ff", "--no-edit", info.branch] : ["cherry-pick", ...inspected.commits];

  const preflight = path.join(os.tmpdir(), `opencode-subagent-preflight-${randomUUID()}`);
  await git(["-C", info.repoRoot, "worktree", "add", "--detach", preflight, "HEAD"]);
  try {
    const result = await exec(["-C", preflight, ...COMMIT_IDENTITY, ...args]);
    if (result.code !== 0) {
      throw new Error(`Preflight found ${action} conflicts, so the source checkout was not changed. ${(result.stderr || result.stdout).trim()}`);
    }
  } finally {
    await exec(["-C", info.repoRoot, "worktree", "remove", "--force", preflight]);
  }
  const applied = await exec(["-C", info.repoRoot, ...COMMIT_IDENTITY, ...args]);
  if (applied.code !== 0) {
    await exec(["-C", info.repoRoot, action, "--abort"]);
    throw new Error(`git ${action} failed: ${(applied.stderr || applied.stdout).trim()}`);
  }
  return { changed: true, files: inspected.files, commits: inspected.commits };
}

/** Deletes the worktree's branch after OpenCode removed the worktree. A branch that is already gone is fine. */
export async function deleteWorktreeBranch(info: WorktreeInfo) {
  if (info.branch === "HEAD") return;
  const exists = await exec(["-C", info.repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${info.branch}`]);
  if (exists.code === 0) await git(["-C", info.repoRoot, "branch", "-D", info.branch]);
}