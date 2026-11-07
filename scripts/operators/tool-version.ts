import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * The commit that the given source files come from, or "unknown" when it cannot be proven. It is proven only when:
 * Git runs without any inherited GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE...); the checkout holding the
 * first file has no modified tracked file (staged or not); and every given file is tracked in that checkout and
 * byte-identical (after Git's own filters) to its blob in HEAD. A copy of the command placed in another repository,
 * an untracked module, or a file marked assume-unchanged therefore gives "unknown". The break-glass library refuses
 * "unknown"; it checks only the shape of the value, so its provenance rests on this function.
 */
export function toolVersion(files: readonly string[]): string {
  if (files.length === 0) return "unknown";
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))) as NodeJS.ProcessEnv;
  const first = resolve(files[0]);
  const at = (cwd: string) => (...args: string[]) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    const root = at(resolve(first, ".."))("rev-parse", "--show-toplevel");
    const git = at(root);
    if (git("status", "--porcelain", "--untracked-files=no")) return "unknown";
    const head = git("rev-parse", "HEAD");
    if (!/^[0-9a-f]{40}$/.test(head)) return "unknown";
    for (const file of new Set(files.map((path) => resolve(path)))) {
      const name = git("ls-files", "--error-unmatch", "--full-name", "--", file); // fails for an untracked or outside file
      if (!name || name.includes("\n")) return "unknown";
      if (git("hash-object", `--path=${name}`, "--", file) !== git("rev-parse", `HEAD:${name}`)) return "unknown";
    }
    return head;
  } catch {
    return "unknown";
  }
}

/** The source files this process has loaded, outside node_modules: what the command actually runs. */
export function loadedSources(entry: string = process.argv[1] ?? ""): string[] {
  const loaded = typeof require === "undefined" ? [] : Object.keys(require.cache);
  return [entry, ...loaded].filter((path) => path && !/[\\/]node_modules[\\/]/.test(path)).map((path) => resolve(path));
}
