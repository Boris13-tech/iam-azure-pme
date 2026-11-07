import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The commit that the given source files come from, or "unknown" when it cannot be proven. It is proven only when the
 * checkout holding the first file has no modified tracked file, and every given file is tracked there and has exactly
 * the bytes of its blob in HEAD. The comparison is done here, on raw bytes: no Git filter (clean, smudge, attributes)
 * runs, and the only difference accepted is CRLF line endings in the file for LF in the blob (a Windows checkout).
 * Git runs without any inherited GIT_* variable, without replacement objects (refs/replace) and without fsmonitor.
 *
 * Scope: the repository's own sources that this process loaded. Dependencies in node_modules and the Node runtime are
 * out of scope (installed from the tracked lockfile). Whoever controls the operator's machine is out of scope too.
 * The break-glass library refuses "unknown"; it checks only the shape of the value, so its provenance rests on this.
 */
export function toolVersion(files: readonly string[]): string {
  if (files.length === 0) return "unknown";
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1" } as unknown as NodeJS.ProcessEnv;
  const at = (cwd: string) => (...args: string[]) => execFileSync("git",
    ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    { cwd, env, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const text = (buffer: Buffer) => buffer.toString().trim();
  try {
    const root = text(at(resolve(files[0], ".."))("rev-parse", "--show-toplevel"));
    const git = at(root);
    if (text(git("status", "--porcelain", "--untracked-files=no"))) return "unknown";
    const head = text(git("rev-parse", "--verify", "HEAD^{commit}"));
    if (!/^[0-9a-f]{40}$/.test(head)) return "unknown";
    for (const file of new Set(files.map((path) => resolve(path)))) {
      const name = text(git("ls-files", "--error-unmatch", "--full-name", "--", file)); // fails for an untracked or outside file
      if (!name || name.includes("\n")) return "unknown";
      const blob = git("cat-file", "blob", `${head}:${name}`); // raw blob, no filter
      const bytes = readFileSync(file);
      const sameBytes = bytes.equals(blob);
      const crlfOnly = !blob.includes(13) && Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1").equals(blob);
      if (!sameBytes && !crlfOnly) return "unknown";
    }
    return head;
  } catch {
    return "unknown";
  }
}

/**
 * The source files this process has loaded, outside node_modules: what the command actually runs. Under a loader whose
 * modules cannot be listed (ES modules), the answer is empty, so the version is "unknown" rather than partial.
 */
export function loadedSources(entry: string = process.argv[1] ?? "", cache: Record<string, unknown> | undefined =
  typeof require === "undefined" ? undefined : require.cache): string[] {
  if (!cache || !entry) return [];
  // Code preloaded from outside node_modules (--require, --import, --loader, on the command line or in NODE_OPTIONS)
  // runs without being listed: refuse (Antigravity, fourth pass of #183). The loader's own preloads live in node_modules.
  if (outsidePreloads(process.execArgv, process.env.NODE_OPTIONS ?? "").length > 0) return [];
  // An entry run as an ES module is not in the CommonJS cache, and neither are the ES modules it imports: refuse.
  if (!Object.prototype.hasOwnProperty.call(cache, resolve(entry))) return [];
  return [entry, ...Object.keys(cache)].map((path) => resolve(path)).filter((path) => !inDependencies(path));
}

/** Whether a path, once resolved (relative parts, "..", symbolic links), lies inside a node_modules folder. */
function inDependencies(path: string): boolean {
  let real = resolve(path);
  try { real = realpathSync.native(real); } catch { /* a missing file is judged by its resolved path */ }
  return /[\\/]node_modules[\\/]/.test(real);
}

/** Preloaded modules (--require/-r, --import, --loader, --experimental-loader) that are not dependencies in node_modules. */
export function outsidePreloads(execArgv: readonly string[], nodeOptions: string): string[] {
  const tokens = [...execArgv, ...(nodeOptions.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ""))];
  const flags = /^(--require|-r|--import|--loader|--experimental-loader)$/;
  const values: string[] = [];
  tokens.forEach((token, index) => {
    const joined = /^(--require|-r|--import|--loader|--experimental-loader)=(.+)$/.exec(token);
    if (joined) values.push(joined[2]);
    else if (flags.test(token) && index + 1 < tokens.length) values.push(tokens[index + 1]);
  });
  // A path or file URL is resolved first ("./node_modules/../x" is not a dependency); a bare package name resolves
  // into node_modules. Anything that cannot be read as either is refused.
  const insideDependencies = (value: string) => {
    try {
      if (value.startsWith("file:")) return inDependencies(fileURLToPath(value));
      if (/^[./\\]|^[A-Za-z]:[\\/]/.test(value)) return inDependencies(value);
      return /^(@[\w.-]+\/)?[\w.-]+(\/[\w./-]*)?$/.test(value) && !value.split("/").includes(".."); // a bare package name
    } catch {
      return false;
    }
  };
  return values.filter((value) => !insideDependencies(value));
}
