import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Prove zero database touch even if a caller invokes the legacy route handlers directly.
vi.mock("@/lib/db/raw-prisma", () => ({
  rawPrisma: new Proxy({}, {
    get() {
      throw new Error("UNSCOPED_PRISMA_TOUCHED_BY_LEGACY_ROUTE");
    },
  }),
}));

import * as auditRoute from "../../app/api/audit/route";
import * as graphRoute from "../../app/api/graph/route";
import * as rolesRoute from "../../app/api/roles/route";
import * as roleByIdRoute from "../../app/api/roles/[id]/route";
import * as settingsRoute from "../../app/api/settings/route";
import * as usersRoute from "../../app/api/users/route";
import * as userByIdRoute from "../../app/api/users/[id]/route";

const root = join(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).flatMap((name) => {
    const child = join(full, name);
    if (statSync(child).isDirectory()) return sourceFiles(relative(root, child));
    return /\.(ts|tsx)$/.test(name) ? [relative(root, child).replace(/\\/g, "/")] : [];
  });
}

const LEGACY_MODULES = [
  ["/api/users", usersRoute],
  ["/api/users/org-b-user", userByIdRoute],
  ["/api/roles", rolesRoute],
  ["/api/roles/org-b-role", roleByIdRoute],
  ["/api/settings", settingsRoute],
  ["/api/audit?take=99999999&skip=-10", auditRoute],
  ["/api/graph", graphRoute],
] as const;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

describe("G2-R01 (F-01): retirement of legacy unscoped API routes and internal error leaks", () => {
  it("neutralizes all 7 legacy endpoints across every HTTP method with 410 LEGACY_API_RETIRED and zero DB access", async () => {
    for (const [path, mod] of LEGACY_MODULES) {
      expect(mod.dynamic, `${path} dynamic`).toBe("force-dynamic");
      for (const method of METHODS) {
        const handler = mod[method];
        expect(typeof handler, `${method} ${path}`).toBe("function");
        for (const orgCookie of ["org-a-session", "org-b-session", ""]) {
          const req = new Request(`https://iam-azure-pme.vercel.app${path}`, {
            method,
            headers: {
              ...(orgCookie ? { cookie: `luxia_session=${orgCookie}` } : {}),
              ...(method !== "GET" && method !== "DELETE" ? { "content-type": "application/json" } : {}),
            },
            ...(method !== "GET" && method !== "DELETE"
              ? { body: JSON.stringify({ organizationId: "foreign-org-id", email: "victim@org-b.test", name: "Cross Org" }) }
              : {}),
          });
          const res = await (handler as (r: Request, ctx?: unknown) => Response | Promise<Response>)(
            req,
            { params: Promise.resolve({ id: "foreign-org-target" }) },
          );
          expect(res.status, `${method} ${path} (${orgCookie || "anon"})`).toBe(410);
          expect(res.headers.get("cache-control")).toBe("no-store, private");
          expect(await res.json()).toEqual({ error: "LEGACY_API_RETIRED" });
        }
      }
    }
  });

  it("removes dead unscoped Graph/auth/permissions facades and legacy RoleForm component", () => {
    expect(existsSync(join(root, "lib/graph.ts"))).toBe(false);
    expect(existsSync(join(root, "lib/auth.ts"))).toBe(false);
    expect(existsSync(join(root, "lib/permissions.ts"))).toBe(false);
    expect(existsSync(join(root, "components/RoleForm.tsx"))).toBe(false);
  });

  it("forbids rawPrisma, legacy global tables, and legacy bridges anywhere in app/ or components/", () => {
    const violations: string[] = [];
    const forbiddenImports = /\brawPrisma\b|from\s+["']@\/lib\/prisma["']|lib\/graph|dual-write-service|legacy-auth-adapter/;
    const forbiddenGlobalModels = /\.(user|role|userRole|rolePermission|auditLog|accessPolicy|legacyUserBridge)\.(find|create|update|delete|upsert|count|aggregate)/;

    for (const file of [...sourceFiles("app"), ...sourceFiles("components")]) {
      const content = readFileSync(join(root, file), "utf8");
      if (forbiddenImports.test(content)) violations.push(`${file}: forbidden legacy/unscoped import`);
      if (forbiddenGlobalModels.test(content)) violations.push(`${file}: direct legacy global table access`);
    }
    expect(violations).toEqual([]);
  });

  it("forbids returning raw error.message in any HTTP route response under app/ (CWE-209)", () => {
    const leaks: string[] = [];
    const routeFiles = sourceFiles("app").filter((file) => file.endsWith("/route.ts"));
    expect(routeFiles.length).toBeGreaterThanOrEqual(30);

    for (const file of routeFiles) {
      const content = readFileSync(join(root, file), "utf8");
      if (/NextResponse\.json\(\s*\{\s*error:\s*[^}]*\berror\.message\b/.test(content)) {
        leaks.push(file);
      }
    }
    expect(leaks).toEqual([]);
  });
});
