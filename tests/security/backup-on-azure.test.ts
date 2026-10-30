import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storageAuthorization } from "../../scripts/backup/azure-token.mjs";

// The backup job moves from GitHub-hosted runners to Azure Container Apps (docs/operations/BACKUP-ON-AZURE.md):
// Production data in clear is then processed only in the operator's Azure subscription. These checks keep the
// image, its build, the job's identity and its permissions as narrow as designed.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const dockerfile = read("infra/backup/Dockerfile");
const dockerignore = read(".dockerignore");
const workflow = read(".github/workflows/backup-image.yml");
const bicep = read("infra/backup/backup-job.bicep");
const backup = read("scripts/backup/backup.mjs");
const authorize = (env: Record<string, string>, fetchImpl: unknown) => storageAuthorization(env as unknown as NodeJS.ProcessEnv, fetchImpl as typeof fetch);

describe("Backup on Azure: managed identity token", () => {
  const env = { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token", IDENTITY_HEADER: "h-123", LUXIA_BACKUP_IDENTITY_CLIENT_ID: "client-1" };
  it("outside Azure there is no identity: the URL must carry its own SAS", async () => {
    expect(await authorize({}, () => { throw new Error("must not call"); })).toBeNull();
    expect(await authorize({ IDENTITY_ENDPOINT: env.IDENTITY_ENDPOINT }, () => { throw new Error("must not call"); })).toBeNull();
  });

  it("asks the local endpoint for a Blob Storage token for the named identity, and returns a Bearer value", async () => {
    let seen: { url: URL; headers: Record<string, string> } | undefined;
    const fake = async (url: URL, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return new Response(JSON.stringify({ access_token: "tok", expires_on: "1" }), { status: 200 });
    };
    expect(await authorize(env, fake)).toBe("Bearer tok");
    expect(seen!.url.origin + seen!.url.pathname).toBe(env.IDENTITY_ENDPOINT);
    expect(Object.fromEntries(seen!.url.searchParams)).toEqual({ resource: "https://storage.azure.com/", "api-version": "2019-08-01", client_id: "client-1" });
    expect(seen!.headers).toEqual({ "X-IDENTITY-HEADER": "h-123" });
  });

  it("refuses without a named identity, on an HTTP error, or without a token; the error never carries a token", async () => {
    await expect(authorize({ ...env, LUXIA_BACKUP_IDENTITY_CLIENT_ID: "" }, async () => new Response("{}"))).rejects.toThrow("LUXIA_BACKUP_IDENTITY_CLIENT_ID is not set");
    await expect(authorize(env, async () => new Response("denied", { status: 403 }))).rejects.toThrow("HTTP 403");
    await expect(authorize(env, async () => new Response(JSON.stringify({ access_token: "" })))).rejects.toThrow("token missing");
  });

  it("the upload uses a SAS or the managed identity, never neither", () => {
    expect(backup).toContain('const authorization = base.search ? null : await storageAuthorization()');
    expect(backup).toContain('if (!base.search && !authorization) fail("the container URL carries no SAS and no managed identity is available")');
  });
});

describe("Backup on Azure: image and its build", () => {
  it("the image is pinned by digest, runs as a non-root user, and holds only the backup scripts", () => {
    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(1);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^COPY scripts\/backup\/ \/app\/scripts\/backup\/$/m);
    expect(dockerfile.match(/^COPY /gm)).toHaveLength(1);
    expect(dockerfile).not.toMatch(/^ENV .*(URL|SECRET|TOKEN|PASSWORD|KEY)/im);
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/scripts/backup/backup.mjs"]');
    expect(dockerignore.split("\n").filter((line) => line && !line.startsWith("#"))).toEqual(["*", "!scripts/backup/"]);
  });

  it("the build runs on main or by hand, with the narrowest permissions, pinned actions, and no Production secret", () => {
    expect(workflow).toMatch(/^on:\n  push:\n    branches: \[main\]\n    paths:\n/m);
    expect(workflow).not.toMatch(/schedule:|pull_request_target/);
    // Pull requests build only: read-only token, no login, no push.
    const check = workflow.slice(workflow.indexOf("\n  build-check:\n"), workflow.indexOf("\n  image:\n"));
    expect(check).toMatch(/if: github.event_name == 'pull_request'\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n    steps:/);
    expect(check).not.toMatch(/docker (login|push)|GH_TOKEN|packages:/);
    expect(workflow.slice(workflow.indexOf("\n  image:\n"))).toMatch(/^\n  image:\n    if: github.event_name != 'pull_request' && github.ref == 'refs\/heads\/main'\n/);
    expect(workflow).toMatch(/^permissions:\n  contents: read\n/m);
    expect(workflow).toMatch(/permissions:\n      contents: read\n      packages: write\n      id-token: write\n      attestations: write\n/);
    for (const uses of workflow.match(/uses: \S+/g)!) expect(uses).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/environment:/);
    // Inputs reach shell steps through env only.
    const runs = [...workflow.matchAll(/run: \|\n((?: {10}.*\n)+)/g)].map((m) => m[1]).join("");
    expect(runs).not.toContain("${{");
    expect(workflow).toContain("push-to-registry: true");
  });
});

describe("Backup on Azure: job, identity and permissions", () => {
  it("no secret is a template parameter; the database URL comes from the backup vault by the job's identity", () => {
    expect(bicep).not.toMatch(/@secure\(\)/);
    expect(bicep).toMatch(/keyVaultUrl: '\$\{vault\.properties\.vaultUri\}secrets\/\$\{databaseUrlSecretName\}'/);
    expect([...bicep.matchAll(/secretRef: '([\w-]+)'/g)].map((m) => m[1])).toEqual(["backup-database-url"]);
  });

  it("the identity creates and reads backup blobs only, on the container; and reads that one secret only", () => {
    const dataActions = /dataActions: \[\n([\s\S]*?)\n\s+\]/.exec(bicep)![1].split("\n").map((line) => line.trim().replace(/'/g, ""));
    expect(dataActions).toEqual([
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
    ]);
    expect(bicep).not.toMatch(/blobs\/delete|\/\*'|Storage Blob Data (Contributor|Owner)|ba92f5b4-2d11-453d-a403-e96b0029c9fe/);
    expect(bicep).toMatch(/resource writerAssignment [^\n]+\n[\s\S]*?scope: container\n/);
    expect(bicep).toMatch(/resource secretAssignment [^\n]+\n[\s\S]*?scope: databaseUrlSecret\n/);
    expect(bicep).toContain("var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'");
  });

  it("the job runs only a digest-pinned image, once at a time, on a schedule, without retries", () => {
    expect(bicep).toContain("resource job 'Microsoft.App/jobs@2024-03-01' = if (imageIsPinned) {");
    expect(bicep).toContain("var imageIsPinned = length(split(image, '@sha256:')) == 2 && length(split(image, '@sha256:')[1]) == 64");
    expect(bicep).toMatch(/triggerType: 'Schedule'/);
    expect(bicep).toMatch(/parallelism: 1\n/);
    expect(bicep).toMatch(/replicaRetryLimit: 0\n/);
    expect(bicep).not.toMatch(/ingress|registries:/);
  });
});
