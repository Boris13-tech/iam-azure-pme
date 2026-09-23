export const DEPLOYMENT_PROFILES = ["CLOUD", "HYBRID", "SOVEREIGN"] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

export const OPERATIONAL_COMPONENTS = [
  "DATABASE",
  "SECRET_CUSTODY",
  "CRYPTO_TRUST",
  "LOCAL_AUTHENTICATION",
  "AUDIT_SINK",
  "LOCAL_POLICY_CACHE",
  "EDGE_RUNTIME",
  "SYNC_QUEUE",
  "EXTERNAL_PROVIDER",
] as const;
export type OperationalComponent = (typeof OPERATIONAL_COMPONENTS)[number];
export type ComponentState = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
export type ReadinessState = "READY" | "DEGRADED" | "NOT_READY";
export type AlertState = "OK" | "WARNING" | "CRITICAL";

export type ComponentSignal = Readonly<{
  component: OperationalComponent;
  state: ComponentState;
  checkedAt: string;
  latencyMs?: number;
  reasonCode?: string;
}>;

export type OperationalReadiness = Readonly<{
  profile: DeploymentProfile;
  state: ReadinessState;
  alert: AlertState;
  checkedAt: string;
  reasons: ReadonlyArray<string>;
  signals: ReadonlyArray<ComponentSignal>;
}>;

const REQUIRED: Readonly<Record<DeploymentProfile, ReadonlySet<OperationalComponent>>> = {
  CLOUD: new Set(["DATABASE", "SECRET_CUSTODY", "CRYPTO_TRUST", "LOCAL_AUTHENTICATION", "AUDIT_SINK"]),
  HYBRID: new Set(["DATABASE", "SECRET_CUSTODY", "CRYPTO_TRUST", "LOCAL_AUTHENTICATION", "AUDIT_SINK", "EDGE_RUNTIME", "LOCAL_POLICY_CACHE"]),
  SOVEREIGN: new Set(["DATABASE", "SECRET_CUSTODY", "CRYPTO_TRUST", "LOCAL_AUTHENTICATION", "AUDIT_SINK", "LOCAL_POLICY_CACHE"]),
};

/** Provider and network loss may degrade a runtime, but never makes canonical identity disappear. */
export function evaluateIdentityReadiness(
  profile: DeploymentProfile,
  signals: ReadonlyArray<ComponentSignal>,
  now = new Date(),
): OperationalReadiness {
  const byComponent = new Map(signals.map((signal) => [signal.component, signal]));
  const reasons: string[] = [];
  let requiredUnavailable = false;
  let degraded = false;

  for (const component of REQUIRED[profile]) {
    const signal = byComponent.get(component);
    if (!signal || signal.state === "UNAVAILABLE") {
      requiredUnavailable = true;
      reasons.push(`${component}_UNAVAILABLE`);
    } else if (signal.state === "DEGRADED") {
      degraded = true;
      reasons.push(`${component}_DEGRADED`);
    }
  }
  for (const signal of signals) {
    if (!REQUIRED[profile].has(signal.component) && signal.state !== "HEALTHY") {
      degraded = true;
      reasons.push(signal.reasonCode ?? `${signal.component}_${signal.state}`);
    }
  }

  const state: ReadinessState = requiredUnavailable ? "NOT_READY" : degraded ? "DEGRADED" : "READY";
  return Object.freeze({
    profile,
    state,
    alert: state === "NOT_READY" ? "CRITICAL" : state === "DEGRADED" ? "WARNING" : "OK",
    checkedAt: now.toISOString(),
    reasons: Object.freeze([...new Set(reasons)].sort()),
    signals: Object.freeze([...signals]),
  });
}

export type RuntimeLifecycleState = "STOPPED" | "STARTING" | "READY" | "DRAINING";

/** Small deterministic lifecycle coordinator for restart-safe runtime integrations. */
export class IdentityRuntimeLifecycle {
  private state: RuntimeLifecycleState = "STOPPED";
  get current(): RuntimeLifecycleState { return this.state; }
  start(): RuntimeLifecycleState {
    if (this.state === "READY" || this.state === "STARTING") return this.state;
    if (this.state === "DRAINING") throw new Error("RUNTIME_DRAINING");
    this.state = "STARTING";
    return this.state;
  }
  markReady(readiness: OperationalReadiness): RuntimeLifecycleState {
    if (this.state !== "STARTING" || readiness.state === "NOT_READY") throw new Error("RUNTIME_NOT_READY");
    this.state = "READY";
    return this.state;
  }
  beginShutdown(): RuntimeLifecycleState {
    if (this.state === "STOPPED" || this.state === "DRAINING") return this.state;
    this.state = "DRAINING";
    return this.state;
  }
  markStopped(): RuntimeLifecycleState {
    if (this.state === "STOPPED") return this.state;
    if (this.state !== "DRAINING") throw new Error("RUNTIME_NOT_DRAINING");
    this.state = "STOPPED";
    return this.state;
  }
}

export type RetryPolicy = Readonly<{ maximumAttempts: number; baseDelayMs: number; maximumDelayMs: number }>;
export type RetryObservation = Readonly<{ attempt: number; delayMs: number; errorCode: string }>;

export async function executeWithBoundedRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  options: Readonly<{
    retryable: (error: unknown) => boolean;
    sleep?: (delayMs: number) => Promise<void>;
    observe?: (event: RetryObservation) => void;
  }>,
): Promise<T> {
  if (!Number.isSafeInteger(policy.maximumAttempts) || policy.maximumAttempts < 1 || policy.maximumAttempts > 10 ||
      policy.baseDelayMs < 0 || policy.maximumDelayMs < policy.baseDelayMs) throw new Error("INVALID_RETRY_POLICY");
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 1; attempt <= policy.maximumAttempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt === policy.maximumAttempts || !options.retryable(error)) throw error;
      const delayMs = Math.min(policy.maximumDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      options.observe?.({ attempt, delayMs, errorCode: safeErrorCode(error) });
      await sleep(delayMs);
    }
  }
  throw new Error("RETRY_EXHAUSTED");
}

const SENSITIVE_KEY = /(secret|password|token|private.?key|credential|authorization|cookie|database.?url)/i;
export function sanitizeOperationalFields(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeValue(value),
  ])));
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") return sanitizeOperationalFields(value as Record<string, unknown>);
  return value;
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "OPERATION_FAILED";
}
