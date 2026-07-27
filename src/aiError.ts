// Client-side counterpart to server aiErrors.ts.
//
// Every AI endpoint now answers with the same shape, so the UI needs ONE place
// that knows how to read it. Before this, each handler did:
//
//     if (!response.ok) throw new Error("Verification API failed");
//
// which THREW AWAY the server's actual explanation — the classified code, the
// actionable message, whether a retry was worth trying — and replaced it with a
// string the user could do nothing with. Worse, `setError(...)` was called 23
// times and rendered nowhere, so the user saw no error at all.

/** Mirrors AiFailureCode on the server. */
export type AiErrorCode =
  | "QUOTA_EXHAUSTED"
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "BAD_RESPONSE"
  | "UPSTREAM_ERROR"
  | "RENDER_FAILED"
  | "NETWORK"      // request never reached the server (offline, DNS, CORS)
  | "UNKNOWN";

export interface ApiFailure {
  code: AiErrorCode;
  /** Message safe and useful to show the user. */
  message: string;
  retryable: boolean;
  status: number | null;
  /** Short label for the guidance line under the message, if any. */
  hint?: string;
}

/** Extra, code-specific guidance. Kept out of the server message so the server
 *  stays transport-agnostic and the wording can be tuned per surface. */
function hintFor(code: AiErrorCode): string | undefined {
  switch (code) {
    case "QUOTA_EXHAUSTED":
      return "The Gemini API credits are exhausted. Top up billing in Google AI Studio, then retry. Meanwhile you can type the details in manually — every step of this wizard works without AI.";
    case "NOT_CONFIGURED":
      return "No GEMINI_API_KEY is set on the server, so AI assistance is off. All manual entry still works.";
    case "TIMEOUT":
      return "The AI service was too slow to answer. Retrying often succeeds.";
    case "UNAUTHORIZED":
      return "The server's API key was rejected. This needs a configuration fix — retrying will not help.";
    case "NETWORK":
      return "Check your internet connection, then retry.";
    default:
      return undefined;
  }
}

const isCode = (v: unknown): v is AiErrorCode =>
  typeof v === "string" &&
  ["QUOTA_EXHAUSTED", "NOT_CONFIGURED", "TIMEOUT", "UNAUTHORIZED",
   "BAD_RESPONSE", "UPSTREAM_ERROR", "RENDER_FAILED"].includes(v);

/**
 * Read a failed Response into an ApiFailure, preferring the server's own
 * classified body over any guess we could make from the status code alone.
 */
export async function parseApiFailure(response: Response, fallbackLabel: string): Promise<ApiFailure> {
  let body: any = null;
  try { body = await response.json(); } catch { /* HTML error page or empty body */ }

  const code: AiErrorCode = isCode(body?.errorCode)
    ? body.errorCode
    // A 429 with no code at all is still unambiguously a rate/quota problem —
    // e.g. from a proxy or load balancer that never reached our handler.
    : response.status === 429 ? "QUOTA_EXHAUSTED"
    : response.status === 503 ? "NOT_CONFIGURED"
    : response.status === 504 ? "TIMEOUT"
    : response.status === 401 || response.status === 403 ? "UNAUTHORIZED"
    : "UNKNOWN";

  const message =
    typeof body?.error === "string" && body.error.trim()
      ? body.error
      : `${fallbackLabel} failed (server returned ${response.status}). Please try again.`;

  return {
    code,
    message,
    retryable: typeof body?.retryable === "boolean" ? body.retryable : response.status >= 500 || response.status === 429,
    status: response.status,
    hint: hintFor(code),
  };
}

/** Classify a thrown value (network error, abort, bug) the same way. */
export function toApiFailure(err: unknown, fallbackLabel: string): ApiFailure {
  // An ApiFailure thrown by parseApiFailure and re-caught upstream: pass through
  // rather than flattening it back to a generic message.
  if (err && typeof err === "object" && isCode((err as any).code) && typeof (err as any).message === "string") {
    return err as ApiFailure;
  }
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const isNetwork = /failed to fetch|networkerror|load failed|err_internet|connection/i.test(raw);
  const isAbort = /abort|timeout|timed out/i.test(raw);
  const code: AiErrorCode = isNetwork ? "NETWORK" : isAbort ? "TIMEOUT" : "UNKNOWN";
  return {
    code,
    message: isNetwork
      ? `Could not reach the server while ${fallbackLabel}. Check your connection and try again.`
      : isAbort
      ? `${fallbackLabel} took too long and was stopped. Please try again.`
      : `${fallbackLabel} failed. Please try again.`,
    retryable: true,
    status: null,
    hint: hintFor(code),
  };
}

/**
 * Convenience wrapper: POST JSON and either return the parsed body or throw an
 * ApiFailure. Handlers can then `catch` once and always have a structured
 * failure rather than a bare string.
 */
export async function postJson<T = any>(url: string, payload: unknown, label: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw toApiFailure(e, label);
  }
  if (!response.ok) throw await parseApiFailure(response, label);
  try {
    return (await response.json()) as T;
  } catch {
    throw {
      code: "BAD_RESPONSE" as AiErrorCode,
      message: `${label} returned a response this app could not read. Please try again.`,
      retryable: true,
      status: response.status,
    } as ApiFailure;
  }
}

/**
 * True when a 200 response is carrying fallback data because the AI step did not
 * run. Reading this is what stops a fallback being mistaken for a verified
 * result — an unflagged HTTP 200 implicitly claims "everything worked".
 */
export function isDegraded(body: any): boolean {
  return body?.degraded === true || body?.aiStatus === "unavailable";
}

/** The user-facing reason a 200 response was degraded, if it was. */
export function degradedFailure(body: any, label: string): ApiFailure | null {
  if (!isDegraded(body)) return null;
  const code: AiErrorCode = isCode(body?.errorCode) ? body.errorCode : "UNKNOWN";
  return {
    code,
    message:
      typeof body?.degradedReason === "string" && body.degradedReason.trim()
        ? body.degradedReason
        : `${label} completed without AI assistance.`,
    retryable: body?.retryable !== false,
    status: 200,
    hint: hintFor(code),
  };
}
