// The decisions of the G4 post-restore command, driven to each of their failing answers. The command's own test
// exercises its refusals through a real process; this one exercises the verdicts, because reading the source cannot
// show that a broken invariant is actually reported as a fault (Codex F5 and Antigravity finding 3, review of #195).
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PARAMETERS, EXPECTED_TRIGGERS, cleanEnvironment, oneTarget, publicAddress, sameServer, triggerFaults, validate,
} from "../../scripts/ops/g4-post-restore-checks.mjs";

/** `validate` calls `fail` and must not return; here it throws so a refusal is visible as one. */
const refuse = (message: string) => { throw new Error(message); };
const validated = (name: string, value: string | undefined) => validate(name, value, refuse);
const COPY = "postgresql://owner:p@127.0.0.1:15560/luxia_restore_rc";

/** The catalog line the command builds for one trigger. */
const line = (name: string, shape: string, state = "O") => `${name}|${shape}|${state}`;
const intact = () => Object.entries(EXPECTED_TRIGGERS).map(([name, shape]) => line(name, shape as string));

describe("G4 post-restore: the connection a drill may use", () => {
  it("accepts a loopback copy whose name marks it disposable, and nothing else", () => {
    expect(validated("U", COPY).database).toBe("luxia_restore_rc");
    expect(validated("U", "postgres://o:p@localhost:5432/luxia_restore").endpoint).toBe("127.0.0.1:5432");
    expect(() => validated("U", undefined)).toThrow("set U");
    expect(() => validated("U", "not a url")).toThrow("U is not a URL");
    expect(() => validated("U", "mysql://o:p@127.0.0.1:5432/luxia_restore")).toThrow("not a postgres URL");
    expect(() => validated("U", "postgresql://o:p@10.0.0.5:5432/luxia_restore")).toThrow("points at 10.0.0.5");
    expect(() => validated("U", "postgresql://o:p@127.0.0.1:5432/neondb")).toThrow("names the database neondb");
    expect(() => validated("U", "postgresql://o:p@127.0.0.1:5432/luxia restore")).toThrow("has no plain database name");
    for (const parameter of ["host=/tmp", "hostaddr=10.0.0.5", "options=-csearch_path%3Dx", "service=production", "target_session_attrs=any"]) {
      expect(() => validated("U", `${COPY}?${parameter}`), parameter).toThrow(`carries the parameter ${parameter.split("=")[0]}`);
    }
    for (const allowed of ALLOWED_PARAMETERS) expect(validated("U", `${COPY}?${allowed}=x`).database).toBe("luxia_restore_rc");
  });

  // Codex F2: the database name alone let the owner checks run on the copy while the runtime-role checks ran on a
  // clean instance of the same name, where a writable migration history would never have been seen.
  it("refuses two URLs that are not one database on one server", () => {
    const owner = validated("A", COPY);
    expect(oneTarget(owner, validated("B", "postgresql://app_user:p@127.0.0.1:15560/luxia_restore_rc"))).toBeNull();
    expect(oneTarget(owner, validated("B", "postgresql://app_user:p@127.0.0.1:15561/luxia_restore_rc")))
      .toBe("the two URLs point at different servers: 127.0.0.1:15560 and 127.0.0.1:15561");
    expect(oneTarget(owner, validated("B", "postgresql://app_user:p@127.0.0.1:15560/luxia_restore_other")))
      .toBe("the two URLs name different databases: luxia_restore_rc and luxia_restore_other");
    // And what the two connections answer about themselves must agree, whatever the URLs said.
    expect(sameServer("luxia_restore_rc on 172.17.0.2/32:5432", "luxia_restore_rc on 172.17.0.2/32:5432")).toBeNull();
    expect(sameServer("luxia_restore_rc on 172.17.0.2/32:5432", "luxia_restore_rc on 172.17.0.9/32:5432"))
      .toContain("the two connections reached different targets");
  });

  // Antigravity finding 1: the server's own address was recorded but never judged, so a local tunnel to a managed
  // database whose name happened to match would have passed.
  it("refuses a server whose own address is reachable beyond this network", () => {
    for (const local of ["socket:none", "127.0.0.1:5432", "172.17.0.2/32:5432", "10.1.2.3:5432", "192.168.1.9:5432", "::1:5432", "fd00::2:5432"]) {
      expect(publicAddress(`luxia_restore_rc on ${local}`), local).toBeNull();
    }
    for (const remote of ["3.120.4.5:5432", "203.0.113.9/32:5432", "2a05:d014::1:5432"]) {
      expect(publicAddress(`luxia_restore_rc on ${remote}`), remote).toContain("reachable beyond this network");
    }
    expect(publicAddress("luxia_restore_rc")).toContain("did not report an address");
  });

  it("hands tools an environment with no libpq variable, whatever the case", () => {
    const clean = cleanEnvironment({ PGHOST: "db.example.com", PGHOSTADDR: "10.0.0.5", pghost: "db.example.com",
      PgService: "production", PATH: "/usr/bin", LUXIA_KEEP: "yes" });
    expect(clean).toEqual({ PATH: "/usr/bin", LUXIA_KEEP: "yes" });
  });
});

describe("G4 post-restore: the guard triggers of the restored copy", () => {
  it("passes only on a copy whose guards are all intact", () => {
    expect(triggerFaults(intact())).toEqual([]);
    // Guards outside the contract are allowed to be there; the eleven are the ones that must be.
    expect(triggerFaults([...intact(), line("freeze_role_mutation", "Role prevent_global_role_mutation BEFORE ROW DELETE,INSERT,UPDATE")])).toEqual([]);
  });

  // Codex F1: O and A fire for ordinary writes; D is disabled and R fires only for a replication apply, so a guard
  // left replica-only refuses nothing the application does. The command used to accept R.
  it("reports a guard that does not fire for an ordinary write, in every state that does not", () => {
    const shape = EXPECTED_TRIGGERS.audit_append_only as string;
    const withState = (state: string) => triggerFaults(intact().filter((l) => !l.startsWith("audit_append_only|")).concat(line("audit_append_only", shape, state)));
    expect(withState("O")).toEqual([]);
    expect(withState("A")).toEqual([]);
    expect(withState("D")).toEqual(["audit_append_only is disabled"]);
    expect(withState("R")).toEqual(["audit_append_only is replica-only, so it does not fire for ordinary writes"]);
    // A guard outside the contract that has been switched off is reported too: the copy must come back intact.
    expect(triggerFaults([...intact(), line("recovery_code_guard", "LocalRecoveryCode luxia_recovery_code_guard BEFORE ROW DELETE,INSERT,UPDATE", "D")]))
      .toEqual(["recovery_code_guard on LocalRecoveryCode is disabled"]);
  });

  // Codex F3: the name and the function alone proved nothing. An enabled trigger of the same name on another table
  // satisfied the check while the protected table had no guard at all.
  it("reports a guard on the wrong table, function, timing, level or operations, and one that is missing", () => {
    const without = (name: string) => intact().filter((l) => !l.startsWith(`${name}|`));
    const faultsFor = (name: string, shape: string) => triggerFaults([...without(name), line(name, shape)]);
    expect(faultsFor("audit_append_only", "AuthenticationEvidence luxia_audit_append_only BEFORE ROW DELETE,UPDATE")[0])
      .toBe("audit_append_only is AuthenticationEvidence luxia_audit_append_only BEFORE ROW DELETE,UPDATE, not CanonicalAdminAuditEvent luxia_audit_append_only BEFORE ROW DELETE,UPDATE");
    expect(faultsFor("invitation_guard", "Invitation luxia_invitation_guard BEFORE ROW DELETE")[0]).toContain("not Invitation luxia_invitation_guard BEFORE ROW DELETE,INSERT,UPDATE");
    expect(faultsFor("invitation_guard", "Invitation luxia_signup_code_guard BEFORE ROW DELETE,INSERT,UPDATE")[0]).toContain("not Invitation luxia_invitation_guard");
    expect(faultsFor("session_guard", "Session luxia_session_guard AFTER ROW INSERT,UPDATE")[0]).toContain("not Session luxia_session_guard BEFORE ROW");
    expect(faultsFor("session_guard", "Session luxia_session_guard BEFORE STATEMENT INSERT,UPDATE")[0]).toContain("not Session luxia_session_guard BEFORE ROW");
    expect(triggerFaults(without("signup_code_guard"))).toEqual(["signup_code_guard is missing"]);
    // Two triggers of one name on different tables are not collapsed: the one on the wrong table is still reported.
    const duplicated = [...without("audit_append_only"), line("audit_append_only", "AuthenticationEvidence luxia_audit_append_only BEFORE ROW DELETE,UPDATE")];
    expect(triggerFaults(duplicated)[0]).toContain("is AuthenticationEvidence");
    expect(triggerFaults([...duplicated, line("audit_append_only", EXPECTED_TRIGGERS.audit_append_only as string)])).toEqual([]);
  });

  it("names every expected guard with its table, function, timing, level and operations", () => {
    expect(Object.keys(EXPECTED_TRIGGERS).length).toBeGreaterThanOrEqual(11);
    for (const [name, shape] of Object.entries(EXPECTED_TRIGGERS)) {
      expect(shape, name).toMatch(/^[A-Za-z]+ luxia_\w+ (BEFORE|AFTER) (ROW|STATEMENT) (DELETE|INSERT|UPDATE|TRUNCATE)(,(DELETE|INSERT|UPDATE|TRUNCATE))*$/);
    }
  });
});
