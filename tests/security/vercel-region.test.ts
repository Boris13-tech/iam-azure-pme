import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// EU migration, gate EU-3 (docs/operations/EU-MIGRATION-RUNBOOK.md): functions run in Frankfurt, next to the
// Neon Frankfurt database. One region only: the Hobby plan allows a single region, and a list the plan does not
// allow makes the deployment fail before the build. Automatic deployments of main stay disabled.
const config = JSON.parse(readFileSync("vercel.json", "utf8"));

describe("Vercel configuration (EU-3)", () => {
  it("runs functions in exactly one region, Frankfurt", () => {
    expect(config.regions).toEqual(["fra1"]);
  });

  it("keeps automatic deployments of main disabled (deploys are exact-commit operator actions)", () => {
    expect(config.git?.deploymentEnabled?.main).toBe(false);
  });

  it("adds no other setting with a security or routing effect", () => {
    expect(Object.keys(config).sort()).toEqual(["$schema", "git", "regions"]);
  });
});
