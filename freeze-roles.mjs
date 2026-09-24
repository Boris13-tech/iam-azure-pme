import fs from 'fs';

let f = 'lib/auth/dual-write-service.ts';
let c = fs.readFileSync(f, 'utf8');

c = c.replace(
  /export async function dualWriteCreateRole\([^\{]+\{/,
  `export async function dualWriteCreateRole(auth: AuthContext, name: string, description: string, permissions: string[]) {\n  throw new Error("Global role definitions are frozen during Phase 5E/5F cutover. Mutation rejected.");`
);

c = c.replace(
  /export async function dualWriteUpdateRolePermissions\([^\{]+\{/,
  `export async function dualWriteUpdateRolePermissions(auth: AuthContext, roleId: string, name: string, description: string, permissions: string[]) {\n  throw new Error("Global role definitions are frozen during Phase 5E/5F cutover. Mutation rejected.");`
);

c = c.replace(
  /export async function dualWriteDeleteRole\([^\{]+\{/,
  `export async function dualWriteDeleteRole(auth: AuthContext, roleId: string) {\n  throw new Error("Global role definitions are frozen during Phase 5E/5F cutover. Mutation rejected.");`
);

fs.writeFileSync(f, c);
