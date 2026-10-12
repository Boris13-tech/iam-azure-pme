// First Admin / Break-glass v1, B5: how a recovery-code sign-in is recognised in the sign-in evidence.
// The evidence method is the generic "CUSTOM"; the assurance profile is the explicit marker, written by
// the recovery sign-in (B2) and by the local adapter's recovery method. Readers never guess from
// reason codes or references.
export const RECOVERY_ASSURANCE_PROFILE = "local-recovery";

/** Display key of a sign-in method: "RECOVERY_CODE" for a recovery-code sign-in, otherwise the method itself. */
export function signInMethodKey(evidence: { method: string; assuranceProfile: string | null }): string {
  return evidence.method === "CUSTOM" && evidence.assuranceProfile === RECOVERY_ASSURANCE_PROFILE ? "RECOVERY_CODE" : evidence.method;
}
