// Next.js instrumentation (monitoring slice 2, M-C): every unhandled server error is reported, scrubbed, with the
// route pattern only (never the URL, headers or body). The reporter is a no-op until LUXIA_ERROR_DSN is set.
export function register() {}

export async function onRequestError(error: unknown, _request: unknown, context: { routePath?: string }) {
  // Next.js pattern: the import sits in a branch the bundler drops for the edge runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportError } = await import("./lib/monitoring/error-reporter");
    await reportError(error, "request", context?.routePath);
  }
}
