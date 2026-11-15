// The decisions of the G4 post-restore command, driven to each of their failing answers. The command's own test
// exercises its refusals through a real process; this one exercises the verdicts, because reading the source cannot
// show that a broken invariant is actually reported as a fault (Codex F5 and Antigravity finding 3, review of #195).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALLOWED_PARAMETERS, EXPECTED_OWNER_ONLY, EXPECTED_TRIGGERS, FINGERPRINT_SQL, TARGET_CHECKS, cleanEnvironment, fingerprintFaults,
  gateRevokes, heldRevokedSql, oneTarget, ownerOnlyFault, publicAddress, referenceOf, refusedTarget, sameServer, triggerFaults,
  unprotectedFault, validate,
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
    for (const allowed of ["sslmode=disable", "connect_timeout=5", "schema=public"]) expect(validated("U", `${COPY}?${allowed}`).database).toBe("luxia_restore_rc");
    expect([...ALLOWED_PARAMETERS].sort()).toEqual(["connect_timeout", "schema", "sslmode"]);
  });

  // Gemini 4 Hydrogen finding 4: Prisma's own parameters were handed to psql, which refuses them, and the schema was
  // not pinned. psql now gets libpq's parameters only; Prisma gets the schema, which must be public.
  it("gives psql libpq's parameters only, and Prisma schema public", () => {
    const target = validated("U", `${COPY}?sslmode=disable&schema=public`);
    expect(new URL(target.url).searchParams.has("schema")).toBe(false);
    expect(new URL(target.url).searchParams.get("sslmode")).toBe("disable");
    expect(new URL(target.prismaUrl).searchParams.get("schema")).toBe("public");
    expect(new URL(validated("U", COPY).prismaUrl).searchParams.get("schema")).toBe("public");
    expect(() => validated("U", `${COPY}?schema=tenant_a`)).toThrow("names the schema tenant_a");
    for (const prismaOnly of ["connection_limit=1", "pool_timeout=5"]) expect(() => validated("U", `${COPY}?${prismaOnly}`)).toThrow("carries the parameter");
    // The reference is a sibling on the same server, under a name that also marks it disposable.
    const reference = referenceOf(target);
    expect(reference.database).toBe("luxia_restore_rc_ref");
    expect(reference.endpoint).toBe(target.endpoint);
    expect(validated("R", reference.url).database).toBe("luxia_restore_rc_ref");
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
    // Loopback is the whole address ::1, not every address that starts with those characters (third review).
    for (const remote of ["3.120.4.5:5432", "203.0.113.9/32:5432", "2a05:d014::1:5432", "::1234:abcd:1:5432", "::10.0.0.1:5432"]) {
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

describe("G4 post-restore: a target that is not established stops the run before it writes", () => {
  // Antigravity finding 1, third review: the target checks recorded a failure and the run went on to migrate and write.
  const ok = TARGET_CHECKS.map((name) => ({ name, ok: true, detail: "fine" }));
  it("goes on only when every target check ran and passed", () => {
    expect(refusedTarget(ok)).toBeNull();
    expect(refusedTarget([{ ...ok[0], ok: false, detail: "the server answers 3.120.4.5" }, ok[1]]))
      .toBe("the target is not established: the server answers 3.120.4.5");
    expect(refusedTarget([ok[0], { ...ok[1], ok: false, detail: "the two connections reached different targets" }]))
      .toContain("different targets");
    // A check that did not run is not a pass.
    expect(refusedTarget([ok[0]])).toContain("did not run");
    expect(refusedTarget([])).toContain("did not run");
  });
});

describe("G4 post-restore: the copy against a database migrated from the same release", () => {
  // Gemini 4 Hydrogen findings 1, 2 and 5: named checks missed what they did not name. Anything missing, changed or
  // added relative to the reference is a fault, whatever its kind.
  const reference = [
    "table Subject r rls=true forced=true",
    "policy Subject tenant_isolation PERMISSIVE ALL to=app_user using=(\"organizationId\" = current_setting('app.org')) check=(\"organizationId\" = current_setting('app.org'))",
    "trigger CREATE TRIGGER audit_append_only BEFORE DELETE OR UPDATE ON public.\"CanonicalAdminAuditEvent\" FOR EACH ROW EXECUTE FUNCTION luxia_audit_append_only() state=O",
    "function luxia_audit_append_only() definer=false config=- body=0cc175b9c0f1b6a831c399e269772661 public=false",
  ];
  it("passes only when the copy matches line for line", () => {
    expect(fingerprintFaults([...reference], reference)).toEqual([]);
    expect(fingerprintFaults([...reference].reverse(), reference)).toEqual([]);
  });
  it("reports a weakened policy, a guard gone, a body changed in place, a table without row-level security, and an addition", () => {
    const weakened = reference.map((line) => line.startsWith("policy") ? line.replace(/using=.*/, "using=true check=true") : line);
    expect(fingerprintFaults(weakened, reference)).toEqual([`missing or changed: ${reference[1]}`, `not in the release: ${weakened[1]}`]);
    expect(fingerprintFaults(reference.filter((line) => !line.startsWith("trigger")), reference)).toEqual([`missing or changed: ${reference[2]}`]);
    const replica = reference.map((line) => line.replace("state=O", "state=R"));
    expect(fingerprintFaults(replica, reference)[0]).toBe(`missing or changed: ${reference[2]}`);
    const rewritten = reference.map((line) => line.replace(/body=\w+/, "body=ffffffffffffffffffffffffffffffff"));
    expect(fingerprintFaults(rewritten, reference)[0]).toBe(`missing or changed: ${reference[3]}`);
    const open = reference.map((line) => line.replace("rls=true forced=true", "rls=false forced=true"));
    expect(fingerprintFaults(open, reference)[0]).toBe(`missing or changed: ${reference[0]}`);
    const extra = "policy Subject anyone PERMISSIVE ALL to=public using=true check=true";
    expect(fingerprintFaults([...reference, extra], reference)).toEqual([`not in the release: ${extra}`]);
  });
  it("reads every kind it compares", () => {
    for (const fragment of ["FROM pg_policies WHERE schemaname = 'public'", "pg_get_triggerdef(t.oid)", "t.tgenabled::text",
      "c.relrowsecurity::text", "c.relforcerowsecurity::text", "p.prosecdef::text", "p.proconfig", "md5(coalesce(p.prosrc, ''))",
      "has_function_privilege('public', p.oid, 'EXECUTE')"])
      expect(FINGERPRINT_SQL, fragment).toContain(fragment);
  });
});

describe("G4 post-restore: the activation gate's narrowings of the runtime role", () => {
  it("reads every narrowing of the release's own gate, expanding ALL by kind", () => {
    const revokes = gateRevokes(readFileSync(".github/workflows/production-activation-gate.yml", "utf8"));
    const has = (object: string, privilege: string, sequence = false) =>
      revokes.some((r: { object: string; privilege: string; sequence: boolean }) => r.object === object && r.privilege === privilege && r.sequence === sequence);
    expect(has("CanonicalAdminAuditEvent", "DELETE")).toBe(true);
    expect(has("AuthenticationEvidence", "TRUNCATE")).toBe(true);
    expect(has("SignupCode", "SELECT")).toBe(true);                    // REVOKE ALL on a table
    expect(has("RetentionRun_id_seq", "USAGE", true)).toBe(true);      // REVOKE ALL on a sequence
    expect(has("_prisma_migrations", "INSERT")).toBe(true);
    expect(has("RetentionHold", "SELECT")).toBe(true);
    expect(has("CanonicalAdminAuditEvent", "SELECT")).toBe(false);     // only what the gate takes away
    // Read in order: REVOKE ALL on Invitation, then GRANT SELECT, INSERT, UPDATE back. Found by running it on a copy:
    // reading the REVOKEs alone reported those three as wrongly held.
    expect(has("Invitation", "DELETE")).toBe(true);
    expect(has("Invitation", "SELECT")).toBe(false);
    expect(has("OrganizationDomain", "UPDATE")).toBe(false);
    expect(gateRevokes(`REVOKE ALL ON "A" FROM app_user;\nGRANT SELECT ON "A" TO app_user;\nREVOKE SELECT ON "A" FROM app_user;`)
      .map((r: { privilege: string }) => r.privilege).sort()).toEqual(["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]);
  });
  it("builds a query that lists what app_user holds again, and refuses anything that is not a plain name", () => {
    const sql = heldRevokedSql([{ object: "Invitation", privilege: "DELETE", sequence: false }, { object: "RetentionRun_id_seq", privilege: "USAGE", sequence: true }]);
    expect(sql).toContain("('Invitation', 'DELETE', false)");
    expect(sql).toContain("has_sequence_privilege('app_user'");
    expect(sql).toContain("to_regclass(format('public.%I', r.object)) IS NOT NULL");
    expect(() => heldRevokedSql([{ object: "x'); DROP TABLE y; --", privilege: "DELETE", sequence: false }])).toThrow("unexpected revoke");
  });
});

describe("G4 post-restore: row-level security and owner-only tables on the copy", () => {
  it("accepts exactly the reviewed exceptions, and reports one more or one fewer", () => {
    expect(unprotectedFault("LegacyUserBridge,Tenant")).toBeNull();
    expect(unprotectedFault("Tenant,LegacyUserBridge")).toBeNull();
    expect(unprotectedFault("LegacyUserBridge,Subject,Tenant")).toBe("without both row-level security flags, beyond the reviewed exceptions: Subject");
    expect(unprotectedFault("Tenant")).toContain("LegacyUserBridge not found");
    expect(unprotectedFault("")).toContain("no longer match the schema");
  });

  it("reports an expected owner-only table that is owner-only no more", () => {
    expect(ownerOnlyFault([...EXPECTED_OWNER_ONLY, "SomethingElse"])).toBeNull();
    expect(ownerOnlyFault(EXPECTED_OWNER_ONLY.filter((name) => name !== "RetentionRun"))).toBe("no longer owner-only: RetentionRun");
    expect(ownerOnlyFault([])).toContain(EXPECTED_OWNER_ONLY.join(", "));
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
