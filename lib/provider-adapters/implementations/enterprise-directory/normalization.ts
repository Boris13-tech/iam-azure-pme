import { createHash } from "node:crypto";
import { ProviderAdapterError } from "../..";
import type { DirectoryRawEntry, EnterpriseDirectoryType, NormalizedDirectoryGroup, NormalizedDirectoryIdentity } from "./types";

export function normalizeDirectoryIdentity(type: EnterpriseDirectoryType, entry: DirectoryRawEntry): NormalizedDirectoryIdentity {
  const attributes = lowerCaseAttributes(entry); const externalObjectId = immutableId(type, attributes);
  const principalName = first(attributes, type === "LDAP" ? ["mail", "uid"] : ["userprincipalname", "samaccountname", "mail"]);
  const displayName = first(attributes, ["displayname", "cn", "name"]) ?? principalName ?? externalObjectId;
  const disabled = type === "LDAP" ? /^true$/i.test(first(attributes, ["pwdaccountlockedtime", "disabled"]) ?? "") :
    (Number(first(attributes, ["useraccountcontrol"]) ?? 0) & 2) === 2;
  return Object.freeze({ externalObjectId, distinguishedName: normalizeDn(entry.dn), displayName: normalize(displayName),
    ...(principalName ? { principalName: normalize(principalName).toLowerCase() } : {}), status: disabled ? "DISABLED" : "ACTIVE",
    attributes: Object.freeze({ email: optional(attributes, "mail"), accountName: optional(attributes, "samaccountname"),
      objectClass: optional(attributes, "objectclass") }), version: first(attributes, ["usnchanged", "modifytimestamp", "entrycsn"]) });
}

export function normalizeDirectoryGroup(type: EnterpriseDirectoryType, entry: DirectoryRawEntry): NormalizedDirectoryGroup {
  const attributes = lowerCaseAttributes(entry); const externalGroupId = immutableId(type, attributes);
  const members = values(attributes, "member").map(normalizeDn).sort();
  return Object.freeze({ externalGroupId, distinguishedName: normalizeDn(entry.dn),
    displayName: normalize(first(attributes, ["displayname", "cn", "name"]) ?? externalGroupId),
    memberExternalIds: Object.freeze([...new Set(members)]), attributes: Object.freeze({ objectClass: optional(attributes, "objectclass") }),
    version: first(attributes, ["usnchanged", "modifytimestamp", "entrycsn"]) });
}

export function directoryProjectionFingerprint(value: NormalizedDirectoryIdentity | NormalizedDirectoryGroup): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortObject(value))).digest("base64url")}`;
}

function immutableId(type: EnterpriseDirectoryType, attributes: Map<string, ReadonlyArray<string>>): string {
  const names = type === "LDAP" ? ["entryuuid", "nsuniqueid"] : ["objectguid", "entryuuid"];
  const raw = first(attributes, names);
  if (!raw) throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory object has no immutable identifier",
    safeDetails: { reason: "IMMUTABLE_ID_MISSING" } });
  const normalized = normalize(raw).toLowerCase();
  if (!/^[a-z0-9+/=_:.\-]{4,256}$/i.test(normalized))
    throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory immutable identifier is invalid",
      safeDetails: { reason: "IMMUTABLE_ID_INVALID" } });
  return normalized;
}
function lowerCaseAttributes(entry: DirectoryRawEntry): Map<string, ReadonlyArray<string>> {
  if (!entry.dn.trim() || entry.dn.includes("\0")) throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory DN is invalid" });
  const map = new Map<string, ReadonlyArray<string>>();
  for (const [key, raw] of Object.entries(entry.attributes)) {
    const value = raw === undefined ? [] : typeof raw === "string" ? [raw] : [...raw];
    map.set(key.toLowerCase(), value.map(normalize).filter(Boolean));
  }
  return map;
}
function first(map: Map<string, ReadonlyArray<string>>, names: ReadonlyArray<string>): string | undefined {
  for (const name of names) { const value = map.get(name)?.[0]; if (value) return value; } return undefined;
}
function values(map: Map<string, ReadonlyArray<string>>, name: string): ReadonlyArray<string> { return map.get(name) ?? []; }
function optional(map: Map<string, ReadonlyArray<string>>, name: string): string | null { return map.get(name)?.[0] ?? null; }
function normalize(value: string): string { return value.normalize("NFC").trim(); }
function normalizeDn(value: string): string { return normalize(value).replace(/\s*,\s*/g, ",").toLowerCase(); }
function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortObject(v)]));
}
