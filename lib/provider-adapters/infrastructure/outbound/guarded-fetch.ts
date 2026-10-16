import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { isPublicAddress } from "./address-policy";

// F4, finding F4-S1: every request to an identity provider (discovery, keys, token) goes through this fetch, because
// the issuer may be chosen by a customer's administrator. HTTPS on port 443 only; the host is resolved ONCE, every
// address must be public, and the connection goes to that validated address (no DNS rebinding between the check and
// the connection) while TLS still verifies the host name; redirects are refused; time and size are bounded. A refusal
// carries a safe reason only, never the URL or the address.
export type OutboundRefusal =
  | "OUTBOUND_URL" | "OUTBOUND_SCHEME" | "OUTBOUND_PORT" | "OUTBOUND_DNS" | "OUTBOUND_PRIVATE_ADDRESS"
  | "OUTBOUND_REDIRECT" | "OUTBOUND_TOO_LARGE" | "OUTBOUND_TIMEOUT" | "OUTBOUND_NETWORK";

export class OutboundRefusedError extends Error {
  constructor(readonly reason: OutboundRefusal) {
    super(reason);
    this.name = "OutboundRefusedError";
  }
}

export type OutboundRequest = Readonly<{
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}>;
export type OutboundResponse = Readonly<{ status: number; headers: Record<string, string>; body: Buffer }>;
/** Resolves a host name to every address it has (all must be public). */
export type Resolve = (host: string) => Promise<string[]>;
/** Sends the request to `pinnedAddress`, with TLS and the Host header still bound to the URL's host name. */
export type Send = (url: URL, pinnedAddress: string, init: OutboundRequest) => Promise<OutboundResponse>;
export type GuardedFetchOptions = Readonly<{ resolve?: Resolve; send?: Send; timeoutMs?: number; maxBytes?: number }>;

export const OUTBOUND_TIMEOUT_MS = 5_000;
export const OUTBOUND_MAX_BYTES = 512 * 1024;

export function createGuardedFetch(options: GuardedFetchOptions = {}): typeof fetch {
  const resolve = options.resolve ?? resolveAll;
  const send = options.send ?? sendPinned;
  const timeoutMs = options.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? OUTBOUND_MAX_BYTES;

  return async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = toUrl(input);
    if (url.protocol !== "https:") throw new OutboundRefusedError("OUTBOUND_SCHEME");
    if (url.port !== "" && url.port !== "443") throw new OutboundRefusedError("OUTBOUND_PORT");
    if (url.username || url.password || url.hash) throw new OutboundRefusedError("OUTBOUND_URL");

    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
    if (addresses.length === 0) throw new OutboundRefusedError("OUTBOUND_DNS");
    if (!addresses.every(isPublicAddress)) throw new OutboundRefusedError("OUTBOUND_PRIVATE_ADDRESS");

    const response = await send(url, addresses[0], {
      method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))),
      body: await bodyBytes(init?.body),
      timeoutMs,
      maxBytes,
      signal: init?.signal ?? undefined,
    });
    if (response.status >= 300 && response.status < 400) throw new OutboundRefusedError("OUTBOUND_REDIRECT");
    if (response.body.length > maxBytes) throw new OutboundRefusedError("OUTBOUND_TOO_LARGE");
    const nullBody = response.status === 204 || response.status === 304;
    return new Response(nullBody ? null : new Uint8Array(response.body), { status: response.status, headers: response.headers });
  } as typeof fetch;
}

function toUrl(input: RequestInfo | URL): URL {
  try {
    return new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
  } catch {
    throw new OutboundRefusedError("OUTBOUND_URL");
  }
}

async function bodyBytes(body: RequestInit["body"]): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  // Streams, blobs and form data are not used by the OIDC client; refusing them keeps the size bound exact.
  throw new OutboundRefusedError("OUTBOUND_URL");
}

async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/** HTTPS to the validated address only: Node's DNS lookup is replaced by one that returns that address. */
const sendPinned: Send = (url, pinnedAddress, init) => new Promise((resolve, reject) => {
  const family = isIP(pinnedAddress);
  const pinnedLookup = (_host: string, options: unknown, callback?: LookupCallback) => {
    const done = (typeof options === "function" ? options : callback) as LookupCallback;
    if (typeof options === "object" && options !== null && (options as { all?: boolean }).all) done(null, [{ address: pinnedAddress, family }]);
    else done(null, pinnedAddress, family);
  };
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const outgoing = request({
    host,
    servername: isIP(host) ? undefined : host,
    port: 443,
    path: `${url.pathname}${url.search}`,
    method: init.method,
    headers: { ...init.headers, host: url.host },
    lookup: pinnedLookup as never,
    agent: false,
    signal: init.signal,
  }, (incoming) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > init.maxBytes) {
        outgoing.destroy();
        reject(new OutboundRefusedError("OUTBOUND_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      resolve({ status: incoming.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
    });
    incoming.on("error", () => reject(new OutboundRefusedError("OUTBOUND_NETWORK")));
  });
  outgoing.setTimeout(init.timeoutMs, () => {
    outgoing.destroy();
    reject(new OutboundRefusedError("OUTBOUND_TIMEOUT"));
  });
  outgoing.on("error", (error) => reject(error instanceof OutboundRefusedError ? error : new OutboundRefusedError("OUTBOUND_NETWORK")));
  if (init.body) outgoing.write(init.body);
  outgoing.end();
});
