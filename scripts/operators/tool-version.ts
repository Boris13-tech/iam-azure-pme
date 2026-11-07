import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";

/**
 * The commit of the repository that holds `directory`, or "unknown" when it cannot be established: not a Git
 * checkout, Git missing, or tracked files that differ from that commit (staged or not). Git runs without any
 * inherited GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE...), and the checkout it reports must contain
 * `directory`: another repository's clean commit can never be borrowed. The break-glass library refuses "unknown";
 * it checks only the shape of the value, so its provenance rests on this function.
 */
export function toolVersion(directory: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))) as NodeJS.ProcessEnv;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, env, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    const inside = relative(realpathSync.native(git("rev-parse", "--show-toplevel")), realpathSync.native(directory));
    if (inside.startsWith("..") || isAbsolute(inside)) return "unknown";
    if (git("status", "--porcelain", "--untracked-files=no")) return "unknown";
    const head = git("rev-parse", "HEAD");
    return /^[0-9a-f]{40}$/.test(head) ? head : "unknown";
  } catch {
    return "unknown";
  }
}
