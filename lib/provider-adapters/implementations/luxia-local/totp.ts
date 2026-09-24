import { createHmac, timingSafeEqual } from "node:crypto";
import { CURRENT_TOTP_CRYPTO, CryptoPolicyError, LUXIA_CRYPTO_ALGORITHMS } from "../../../identity";

export function verifyTotp(
  secret: Uint8Array,
  candidate: string,
  nowMs: number,
  lastStep?: number,
  crypto: Readonly<{ algorithmId: string; algorithmVersion: number }> = CURRENT_TOTP_CRYPTO,
): number | null {
  let algorithm;
  try { algorithm = LUXIA_CRYPTO_ALGORITHMS.resolve(crypto.algorithmId, crypto.algorithmVersion, "TOTP", "VERIFY"); }
  catch (error) { if (error instanceof CryptoPolicyError) return null; throw error; }
  if (!algorithm.nodeHmacDigest) return null;
  if (!/^\d{6}$/.test(candidate)) return null;
  const current = Math.floor(nowMs / 30_000);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== undefined && step <= lastStep) continue;
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac(algorithm.nodeHmacDigest, secret).update(counter).digest();
    const offset = mac[mac.length - 1] & 0x0f;
    const binary = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
    const expected = String(binary % 1_000_000).padStart(6, "0");
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) return step;
  }
  return null;
}
