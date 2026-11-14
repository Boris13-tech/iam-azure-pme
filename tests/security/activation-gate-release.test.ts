// The activation gate applies the release the operator authorized, never main's tip (2026-11-12): the workflow comes from
// main, but the code it installs and the migrations it runs come from the one commit named by the release, verified
// before the approval and again after it, and the database must then hold exactly that release's migrations.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const text = readFileSync(".github/workflows/production-activation-gate.yml", "utf8").replace(/\r\n/g, "\n");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Step = { id?: string; name?: string; if?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string };
type Job = { steps: Step[]; outputs?: Record<string, string>; environment?: string };
const gate = yaml.load(text) as { on: { workflow_dispatch: { inputs: Record<string, { required?: boolean; type?: string }> } }; jobs: Record<string, Job> };
const verified = gate.jobs["ci-verified"], activation = gate.jobs["database-activation"];
const index = (job: Job, match: (s: Step) => boolean) => job.steps.findIndex(match);

describe("activation gate: the authorized release, not main's tip", () => {
  it("one Production operation at a time, never queued: no concurrency group; refused in the first job, and again inside every Production job", () => {
    type Wf = { concurrency?: unknown; jobs: Record<string, Job & { concurrency?: unknown; permissions?: unknown }> };
    const load = (path: string) => yaml.load(readFileSync(path, "utf8").replace(/\r\n/g, "\n")) as Wf;
    const deploy = load(".github/workflows/production-deploy.yml"), identity = load(".github/workflows/production-identity-bootstrap.yml");
    const own = yaml.load(text) as Wf;
    // No concurrency group anywhere, workflow or job: a group keeps one pending run, which a later dispatch or a re-run
    // of a Production job alone replaces (Codex, reviews of #191).
    for (const workflow of [own, deploy, identity]) {
      expect(workflow.concurrency).toBeUndefined();
      for (const job of Object.values(workflow.jobs)) expect(job.concurrency).toBeUndefined();
    }
    // Inside every job bound to Production: checked again after the approval and before anything acts, so a re-run of
    // that job alone (its first job is then not run again) is checked too.
    const env = { GH_TOKEN: "${{ github.token }}", REPO: "${{ github.repository }}", RUN_ID: "${{ github.run_id }}" };
    const production = [own.jobs["database-activation"], deploy.jobs.deploy, identity.jobs["canonical-identity-bootstrap"]];
    for (const job of production) {
      expect(job.environment).toBe("Production");
      const at = job.steps.findIndex((s) => (s.run ?? "").includes("scripts/ops/verify-no-other-operation.sh"));
      expect(at).toBeGreaterThan(0);
      expect(job.steps[at].if).toBeUndefined();
      expect(job.steps[at].env).toEqual(env);
      // Nothing before it reads a Production secret or calls an external service.
      for (const before of job.steps.slice(0, at)) {
        expect(JSON.stringify(before.env ?? {})).not.toContain("secrets.");
        expect(before.run ?? "").not.toMatch(/psql|prisma|curl|vercel/i);
      }
      expect((job.permissions as Record<string, string>).actions).toBe("read");
    }
    expect(deploy.jobs.deploy.steps.find((s) => s.id === "alone")!.run).toContain('|| refuse "another Production operation is open"');
    expect(own.jobs["canonical-identity-bootstrap"].permissions).toEqual({ contents: "read", actions: "read" });
    // The check also comes first in the job that runs before any approval, in both dispatched workflows, for every operation.
    for (const [job, checkout] of [[own.jobs["ci-verified"], 0], [deploy.jobs.verify, 0]] as const) {
      expect(job.steps[checkout].uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
      const busy = job.steps[checkout + 1];
      expect(busy.if).toBeUndefined();
      expect(busy.env).toEqual({ GH_TOKEN: "${{ github.token }}", REPO: "${{ github.repository }}", RUN_ID: "${{ github.run_id }}" });
      expect(busy.run).toBe("bash scripts/ops/verify-no-other-operation.sh");
    }
  });

  it("the posture check refuses a runtime role that can write the migration history", () => {
    expect(text).toContain('if (history[0]?.writable !== false) throw new Error("Runtime role can write the migration history");');
  });

  it("takes the release and its SHA as inputs", () => {
    expect(gate.on.workflow_dispatch.inputs.release).toMatchObject({ type: "string" });
    expect(gate.on.workflow_dispatch.inputs.sha).toMatchObject({ type: "string" });
  });

  it("before the approval: the release resolves to one commit on main with green CI, inputs through env only", () => {
    const release = verified.steps.find((s) => s.id === "release")!;
    expect(release.if).toBe("${{ inputs.operation == '' || inputs.operation == 'activation' }}");
    expect(release.env).toEqual({ RELEASE: "${{ inputs.release }}", SHA: "${{ inputs.sha }}", GH_TOKEN: "${{ github.token }}", REPO: "${{ github.repository }}" });
    expect(release.run).toContain('bash scripts/ops/verify-release.sh "$RELEASE" "$SHA"');
    expect(release.run).not.toContain("${{");
    expect(verified.outputs?.release_sha).toBe("${{ steps.release.outputs.sha }}");
    expect(JSON.stringify(verified)).not.toMatch(/environment|secrets\./);
  });

  it("the Production job checks out the verified commit, never the dispatch ref, and checks it again after the approval", () => {
    expect(activation.environment).toBe("Production");
    expect((activation as Job & { permissions?: unknown }).permissions).toEqual({ contents: "read", actions: "read" });
    const checkouts = activation.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkouts.map((s) => s.with)).toEqual([
      { ref: "${{ needs.ci-verified.outputs.release_sha }}", "persist-credentials": false },
      { path: ".gate", "sparse-checkout": "scripts/ops", "persist-credentials": false },
    ]);
    expect(index(activation, (s) => s.uses?.startsWith("actions/checkout@") ?? false)).toBe(0);
    const after = activation.steps.find((s) => s.name === "After approval, the release still resolves to the checked-out commit")!;
    expect(after.run).toContain('bash .gate/scripts/ops/verify-release.sh "$RELEASE" "$SHA"');
    expect(after.run).toContain('[[ "$head" == "$SHA" ]] || { echo "REFUSED: checked out $head, not the authorized $SHA"; exit 1; }');
    // Before anything reads a Production secret.
    const firstSecret = index(activation, (s) => JSON.stringify(s).includes("secrets.") || /DATABASE_(MIGRATION_)?URL/.test(s.run ?? ""));
    expect(index(activation, (s) => s === after)).toBeLessThan(firstSecret);
  });

  it("after the migrations, the database holds exactly the release's migrations", () => {
    const migrate = index(activation, (s) => s.run === "npx prisma migrate deploy");
    const schema = index(activation, (s) => s.name === "The applied migrations are exactly the release's");
    expect(schema).toBe(migrate + 1);
    // And before: a database ahead of the release is refused before anything runs.
    expect(activation.steps[migrate - 1].run).toContain("bash .gate/scripts/ops/verify-schema-release.sh prisma/migrations --before-migrate");
    expect(activation.steps[schema].run).toContain("bash .gate/scripts/ops/verify-schema-release.sh prisma/migrations");
  });

  it("functions that came after rc-private-beta-1 are granted only when the release has them; the posture check covers owner-only tables", () => {
    for (const fn of ["luxia_retention_purge_invitations(integer,boolean)", "luxia_retention_pseudonymize_retired(integer,boolean)", "luxia_retention_status()"])
      expect(text).toContain(`DO $$ BEGIN IF to_regprocedure('public.${fn}') IS NOT NULL THEN`);
    expect(text).toContain("Runtime role holds privileges on owner-only tables");
  });
});
