// Opt-in test instrumentation only. Never emits operation inputs or raw errors.
const pending = new Map<string, number>();
export const pendingDiagnosticSteps = () => [...pending.keys()];
export async function diagnosticStep<T>(label: string, work: () => Promise<T>): Promise<T> {
  if (process.env.LUXIA_RESOURCE_DIAGNOSTICS !== 'true') return work();
  const wall = Date.now(), monotonic = process.hrtime.bigint();
  pending.set(label, wall);
  const emit = (phase: string, code?: string) => console.log(JSON.stringify({
    diagnostic: 'RESOURCE_TEST_STEP', label, phase, utc: new Date().toISOString(),
    wallElapsedMs: Date.now() - wall, monotonicElapsedMs: Number(process.hrtime.bigint()-monotonic)/1e6,
    ...(code ? { safeErrorCode: code } : {}),
  }));
  emit('START');
  const heartbeat = setInterval(() => emit('WAITING'), 5000);
  heartbeat.unref();
  try { const result = await work(); emit('DONE'); return result; }
  catch (error) { const candidate = (error as { code?: unknown })?.code;
    emit('FAILED', typeof candidate === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidate) ? candidate : 'TEST_STEP_FAILED'); throw error;
  } finally { clearInterval(heartbeat); pending.delete(label); }
}
