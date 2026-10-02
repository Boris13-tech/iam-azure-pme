import { describe, expect, it } from "vitest";
import { SubjectLifecycleState as PrismaLifecycleState, SubjectType } from "@prisma/client";
import {
  SUBJECT_KINDS,
  SUBJECT_LIFECYCLE_STATES,
  assertSubjectLifecycleTransition,
  canTransitionSubject,
  type CredentialDescriptor,
} from "../../lib/identity";

describe("Phase 6D universal Subject semantics", () => {
  it("uses one exhaustive canonical kind vocabulary for human and non-human subjects", () => {
    expect(SUBJECT_KINDS).toEqual(["HUMAN", "DEVICE", "WORKLOAD", "SERVICE", "AI_AGENT"]);
    expect(new Set(SUBJECT_KINDS).size).toBe(5);
    expect(Object.values(SubjectType).sort()).toEqual([...SUBJECT_KINDS].sort());
  });

  it("defines typed lifecycle states and makes RETIRED terminal", () => {
    expect(SUBJECT_LIFECYCLE_STATES).toEqual([
      "PROVISIONING", "ACTIVE", "SUSPENDED", "DISABLED", "RECOVERY_REQUIRED", "RETIRED",
    ]);
    expect(Object.values(PrismaLifecycleState).sort()).toEqual([...SUBJECT_LIFECYCLE_STATES].sort());
    for (const state of SUBJECT_LIFECYCLE_STATES) {
      if (state !== "RETIRED") expect(canTransitionSubject(state, "RETIRED")).toBe(true);
    }
    expect(canTransitionSubject("RETIRED", "ACTIVE")).toBe(false);
    expect(() => assertSubjectLifecycleTransition("RETIRED", "ACTIVE")).toThrow("INVALID_SUBJECT_LIFECYCLE_TRANSITION");
  });

  it("allows recovery without silently bypassing disabled/retired lifecycle", () => {
    expect(canTransitionSubject("ACTIVE", "RECOVERY_REQUIRED")).toBe(true);
    expect(canTransitionSubject("RECOVERY_REQUIRED", "ACTIVE")).toBe(true);
    expect(canTransitionSubject("RETIRED", "RECOVERY_REQUIRED")).toBe(false);
  });

  it("describes credentials without provider claims or plaintext secrets", () => {
    const descriptor: CredentialDescriptor = {
      schemaVersion: 1,
      credentialId: "credential-a",
      subjectId: "subject-a",
      type: "WORKLOAD_KEY",
      format: "spki",
      formatVersion: 1,
      status: "ACTIVE",
      algorithmId: "ES256",
      keyId: "key-a",
      keyVersion: "1",
      trustAnchorId: "anchor-a",
      trustAnchorVersion: "2",
      verifierPolicyVersion: 1,
      hardwareBound: true,
      exportability: "PUBLIC_ONLY",
    };
    expect(JSON.stringify(descriptor)).not.toMatch(/secret|password|token|azure|entra|google/i);
  });
});
