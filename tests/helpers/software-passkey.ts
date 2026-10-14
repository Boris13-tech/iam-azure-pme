import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// Test-only software authenticator (ES256, P-256). It produces the same fields a browser sends for a
// registration (attestation "none") and for an assertion, so server checks run unmodified.
const b64 = (value: Buffer) => value.toString("base64url");

export function softwarePasskey(rpId = "localhost", origin = "http://localhost:3000", credentialIdBytes = 32) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rawId = randomBytes(credentialIdBytes);
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, "base64url"),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, "base64url"),
  ]);
  const rpIdHash = createHash("sha256").update(rpId).digest();
  let counter = 0;
  return {
    credentialId: b64(rawId),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    register(challenge: string, overrides: { flags?: number; type?: string; origin?: string; rpId?: string; publicKey?: string; credentialId?: string } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: overrides.type ?? "webauthn.create", challenge, origin: overrides.origin ?? origin, crossOrigin: false }));
      const length = Buffer.alloc(2); length.writeUInt16BE(rawId.length);
      const hash = overrides.rpId ? createHash("sha256").update(overrides.rpId).digest() : rpIdHash;
      const authenticatorData = Buffer.concat([hash, Buffer.from([overrides.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), length, rawId, cose]);
      return {
        credentialId: overrides.credentialId ?? b64(rawId), clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData),
        publicKey: overrides.publicKey ?? b64(publicKey.export({ format: "der", type: "spki" }) as Buffer),
      };
    },
    assert(challenge: string, overrides: { counter?: number; crossOrigin?: boolean } = {}) {
      counter += 1;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin,
        ...(overrides.crossOrigin === undefined ? {} : { crossOrigin: overrides.crossOrigin }) }));
      const count = Buffer.alloc(4); count.writeUInt32BE(overrides.counter ?? counter);
      const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05]), count]);
      const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), privateKey);
      return { credentialId: b64(rawId), clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature) };
    },
  };
}
