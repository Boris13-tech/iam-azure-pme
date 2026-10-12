import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import { ProviderAdapterError } from "../..";

// Server-side checks of a passkey registration (attestation "none"), used when there is no session
// yet (organization signup, invitation acceptance). It binds the stored public key to this ceremony:
// clientData type, challenge and origin; rpId hash; user presence and user verification; the
// credential id and the ES256 P-256 key inside the authenticator data must match what is stored.
const MAX_FIELD_BYTES = 16_384;

export type PasskeyRegistration = {
  credentialId: string;      // base64url rawId
  clientDataJSON: string;    // base64url
  authenticatorData: string; // base64url (AuthenticatorAttestationResponse.getAuthenticatorData())
  publicKey: string;         // base64url SPKI DER (AuthenticatorAttestationResponse.getPublicKey())
};

export function registrationChallenge(clientDataJSON: string): string | null {
  try {
    const client = JSON.parse(decode(clientDataJSON).toString("utf8"));
    return typeof client?.challenge === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(client.challenge) ? client.challenge : null;
  } catch { return null; }
}

export function verifyPasskeyRegistration(input: PasskeyRegistration & { expectedChallenge: string; expectedOrigin: string; rpId: string }): { credentialId: string; publicKeyPem: string } {
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { client = JSON.parse(decode(input.clientDataJSON).toString("utf8")); } catch { return fail("REGISTRATION_CLIENT_DATA_INVALID"); }
  if (client.type !== "webauthn.create" || client.challenge !== input.expectedChallenge ||
      client.origin !== input.expectedOrigin || client.crossOrigin === true) fail("REGISTRATION_CLIENT_DATA_MISMATCH");

  const data = decode(input.authenticatorData);
  if (data.length < 55) fail("REGISTRATION_AUTH_DATA_INVALID");
  if (!timingSafeEqual(data.subarray(0, 32), createHash("sha256").update(input.rpId).digest())) fail("REGISTRATION_RP_MISMATCH");
  const flags = data[32];
  if ((flags & 0x01) === 0) fail("REGISTRATION_USER_PRESENCE_REQUIRED");
  if ((flags & 0x04) === 0) fail("REGISTRATION_USER_VERIFICATION_REQUIRED");
  if ((flags & 0x40) === 0) fail("REGISTRATION_CREDENTIAL_DATA_MISSING");
  const idLength = data.readUInt16BE(53);
  if (idLength < 16 || idLength > 1023 || data.length < 55 + idLength) fail("REGISTRATION_AUTH_DATA_INVALID");
  const credentialId = data.subarray(55, 55 + idLength);
  const presented = decode(input.credentialId);
  if (presented.length !== credentialId.length || !timingSafeEqual(presented, credentialId)) fail("REGISTRATION_CREDENTIAL_MISMATCH");
  const cose = readCoseEc2(data.subarray(55 + idLength));

  const der = decode(input.publicKey);
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey({ key: der, format: "der", type: "spki" }); } catch { return fail("REGISTRATION_PUBLIC_KEY_INVALID"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") fail("REGISTRATION_ALGORITHM_UNSUPPORTED");
  const jwk = key.export({ format: "jwk" }) as { x?: string; y?: string };
  if (jwk.x !== cose.x.toString("base64url") || jwk.y !== cose.y.toString("base64url")) fail("REGISTRATION_PUBLIC_KEY_MISMATCH");
  const publicKeyPem = key.export({ format: "pem", type: "spki" }).toString();
  return { credentialId: credentialId.toString("base64url"), publicKeyPem };
}

// Minimal CBOR reader for the COSE_Key of an ES256 credential: a map of small integer keys with
// integer or byte-string values. kty 2 (EC2), alg -7 (ES256), crv 1 (P-256), x and y of 32 bytes.
function readCoseEc2(bytes: Buffer): { x: Buffer; y: Buffer } {
  let offset = 0;
  const head = () => {
    if (offset >= bytes.length) fail("REGISTRATION_COSE_INVALID");
    const initial = bytes[offset++]; const major = initial >> 5; const info = initial & 0x1f;
    let value: number;
    if (info < 24) value = info;
    else if (info === 24) { if (offset + 1 > bytes.length) fail("REGISTRATION_COSE_INVALID"); value = bytes[offset]; offset += 1; }
    else if (info === 25) { if (offset + 2 > bytes.length) fail("REGISTRATION_COSE_INVALID"); value = bytes.readUInt16BE(offset); offset += 2; }
    else return fail("REGISTRATION_COSE_INVALID");
    return { major, value };
  };
  const integer = () => {
    const { major, value } = head();
    if (major === 0) return value;
    if (major === 1) return -1 - value;
    return fail("REGISTRATION_COSE_INVALID");
  };
  const map = head();
  if (map.major !== 5 || map.value > 10) fail("REGISTRATION_COSE_INVALID");
  const fields = new Map<number, number | Buffer>();
  for (let i = 0; i < map.value; i++) {
    const key = integer();
    const peek = bytes[offset] >> 5;
    if (peek === 2) {
      const { value } = head();
      if (offset + value > bytes.length) fail("REGISTRATION_COSE_INVALID");
      fields.set(key, bytes.subarray(offset, offset + value)); offset += value;
    } else fields.set(key, integer());
  }
  const x = fields.get(-2), y = fields.get(-3);
  if (fields.get(1) !== 2 || fields.get(3) !== -7 || fields.get(-1) !== 1 ||
      !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) fail("REGISTRATION_ALGORITHM_UNSUPPORTED");
  return { x, y };
}

function decode(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) fail("REGISTRATION_FIELD_INVALID");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.length > MAX_FIELD_BYTES) fail("REGISTRATION_FIELD_INVALID");
  return decoded;
}
function fail(reason: string): never {
  throw new ProviderAdapterError({ code: "AUTHENTICATION_FAILED", message: "Passkey registration rejected", safeDetails: { reason } });
}
