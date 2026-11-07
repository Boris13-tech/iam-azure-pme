import { execFileSync } from "node:child_process";

/**
 * The commit of the repository that holds `directory`, or "unknown" when it cannot be established: not a Git
 * checkout, Git missing, or tracked files that differ from that commit (staged or not). The break-glass library
 * refuses "unknown"; it checks only the shape of the value, so its provenance rests on this function.
 */
export function toolVersion(directory: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    if (git("status", "--porcelain", "--untracked-files=no")) return "unknown";
    const head = git("rev-parse", "HEAD");
    return /^[0-9a-f]{40}$/.test(head) ? head : "unknown";
  } catch {
    return "unknown";
  }
}
