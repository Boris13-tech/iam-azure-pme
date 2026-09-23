import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { CryptoPolicyError, LUXIA_CRYPTO_ALGORITHMS } from "../../../identity";
import { ProviderAdapterError } from "../..";
import type { LocalAuthenticatorRecord, PasskeyAssertion } from "./types";

const MAX_WEBAUTHN_FIELD_BYTES = 16_384;
const decode = (value: string) => {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.length > MAX_WEBAUTHN_FIELD_BYTES) fail("PASSKEY_FIELD_SIZE_INVALID");
  return decoded;
};

export function verifyPasskeyAssertion(input: {
  assertion: PasskeyAssertion;
  authenticator: LocalAuthenticatorRecord;
  expectedChallenge: string;
}): number {
  const { assertion, authenticator } = input;
  let algorithm;
  try {
    algorithm = LUXIA_CRYPTO_ALGORITHMS.resolve(
      authenticator.algorithmId,
      authenticator.algorithmVersion,
      "WEBAUTHN_ASSERTION",
      "VERIFY",
    );
  } catch (error) {
    if (error instanceof CryptoPolicyError) fail("PASSKEY_UNSUPPORTED_CRYPTO_VERSION");
    throw error;
  }
  if (!algorithm.hashDigest || !algorithm.nodeSignatureDigest) fail("PASSKEY_UNSUPPORTED_CRYPTO_VERSION");
  const digest = (value: string | Buffer) => createHash(algorithm.hashDigest!).update(value).digest();
  if (!authenticator.publicKey || !authenticator.relyingPartyId || !authenticator.allowedOrigin ||
      assertion.credentialId !== authenticator.credentialId) fail("PASSKEY_BINDING_INVALID");
  if (Buffer.byteLength(authenticator.publicKey, "utf8") > MAX_WEBAUTHN_FIELD_BYTES)
    fail("PASSKEY_PUBLIC_KEY_SIZE_INVALID");
  let client: { type?: string; challenge?: string; origin?: string };
  try { client = JSON.parse(decode(assertion.clientDataJSON).toString("utf8")); }
  catch { return fail("PASSKEY_CLIENT_DATA_INVALID"); }
  if (client.type !== "webauthn.get" || client.challenge !== input.expectedChallenge ||
      client.origin !== authenticator.allowedOrigin) fail("PASSKEY_CLIENT_DATA_MISMATCH");
  const authData = decode(assertion.authenticatorData);
  if (authData.length < 37 || !timingSafeEqual(authData.subarray(0, 32), digest(authenticator.relyingPartyId!)))
    fail("PASSKEY_RP_MISMATCH");
  if ((authData[32] & 0x01) === 0) fail("PASSKEY_USER_PRESENCE_REQUIRED");
  if (authenticator.userVerificationRequired && (authData[32] & 0x04) === 0)
    fail("PASSKEY_USER_VERIFICATION_REQUIRED");
  const counter = authData.readUInt32BE(33);
  if (counter !== 0 && counter <= authenticator.signCount) fail("PASSKEY_REPLAY_DETECTED");
  const signed = Buffer.concat([authData, digest(decode(assertion.clientDataJSON))]);
  let publicKey;
  try { publicKey = createPublicKey(authenticator.publicKey!); }
  catch { return fail("PASSKEY_PUBLIC_KEY_INVALID"); }
  if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    fail("PASSKEY_ALGORITHM_KEY_MISMATCH");
  if (!verify(algorithm.nodeSignatureDigest, signed, publicKey, decode(assertion.signature)))
    fail("PASSKEY_SIGNATURE_INVALID");
  return counter;
}

function fail(reason: string): never {
  throw new ProviderAdapterError({ code: "AUTHENTICATION_FAILED", message: "Local passkey authentication failed", safeDetails: { reason } });
}
