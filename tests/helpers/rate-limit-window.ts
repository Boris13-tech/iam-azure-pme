import { rawPrisma } from "../../lib/db/raw-prisma";

// luxia_rate_limit_hit counts hits in FIXED windows of the database clock: floor(epoch(clock_timestamp()) / window).
// A test that makes several hits and expects the limit to bite must make them all inside one window. Otherwise a run
// that crosses a boundary (a 10-minute mark, the hour, midnight UTC) splits the hits between two windows and the limit
// never bites (CI run 38832423417 crossed 01:00:00Z: 200 instead of 401). Production behavior is not changed.

/** Seconds to wait so that `neededSeconds` fit inside one window, from the database clock `epoch` (0 when they fit). */
export function secondsUntilRoomInWindow(epoch: number, windowSeconds: number, neededSeconds: number): number {
  if (!(neededSeconds > 0 && neededSeconds < windowSeconds)) throw new Error("RATE_LIMIT_TEST_WINDOW_INVALID");
  const remaining = windowSeconds - (epoch % windowSeconds);
  return remaining < neededSeconds ? remaining + 1 : 0; // one second past the boundary
}

/** Waits, when needed, for the next window of the database clock, so that the next `neededSeconds` share one window. */
export async function withinOneRateLimitWindow(windowSeconds: number, neededSeconds: number): Promise<void> {
  const [{ epoch }] = await rawPrisma.$queryRaw<Array<{ epoch: number }>>`SELECT extract(epoch FROM clock_timestamp())::float8 AS epoch`;
  const wait = secondsUntilRoomInWindow(Number(epoch), windowSeconds, neededSeconds);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait * 1000)));
}
