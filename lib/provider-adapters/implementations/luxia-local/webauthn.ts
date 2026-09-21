import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { ProviderAdapterError } from "../..";
import type { LocalAuthenticatorRecord, PasskeyAssertion } from "./types";

const decode = (value: string) => Buffer.from(value, "base64url");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest();

export function verifyPasskeyAssertion(input: {
  assertion: PasskeyAssertion;
  authenticator: LocalAuthenticatorRecord;
  expectedChallenge: string;
}): number {
  const { assertion, authenticator } = input;
  if (!authenticator.publicKey || !authenticator.relyingPartyId || !authenticator.allowedOrigin ||
      assertion.credentialId !== authenticator.credentialId) fail("PASSKEY_BINDING_INVALID");
  let client: { type?: string; challenge?: string; origin?: string };
  try { client = JSON.parse(decode(assertion.clientDataJSON).toString("utf8")); }
  catch { return fail("PASSKEY_CLIENT_DATA_INVALID"); }
  if (client.type !== "webauthn.get" || client.challenge !== input.expectedChallenge ||
      client.origin !== authenticator.allowedOrigin) fail("PASSKEY_CLIENT_DATA_MISMATCH");
  const authData = decode(assertion.authenticatorData);
  if (authData.length < 37 || !timingSafeEqual(authData.subarray(0, 32), digest(authenticator.relyingPartyId!)))
    fail("PASSKEY_RP_MISMATCH");
  if ((authData[32] & 0x01) === 0) fail("PASSKEY_USER_PRESENCE_REQUIRED");
  const counter = authData.readUInt32BE(33);
  if (counter !== 0 && counter <= authenticator.signCount) fail("PASSKEY_REPLAY_DETECTED");
  const signed = Buffer.concat([authData, digest(decode(assertion.clientDataJSON))]);
  if (!verify("sha256", signed, createPublicKey(authenticator.publicKey!), decode(assertion.signature)))
    fail("PASSKEY_SIGNATURE_INVALID");
  return counter;
}

function fail(reason: string): never {
  throw new ProviderAdapterError({ code: "AUTHENTICATION_FAILED", message: "Local passkey authentication failed", safeDetails: { reason } });
}
