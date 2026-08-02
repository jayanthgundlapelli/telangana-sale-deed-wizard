// Shared classification of upstream AI (Gemini) failures.
//
// Why this module exists: quota detection used to be copy-pasted in two places
// with DIVERGENT regexes — one matched "rate limit" but not "credits are
// depleted", the other the reverse — while the remaining 8 call sites had no
// quota awareness at all and reported a depleted-credits 429 as a generic 500.
// Classifying in one place means every endpoint reports the same failure the
// same way, and a new failure mode is taught to the whole app at once.
//
// The guiding rule for this app: it produces legal instruments for
// registration. A failed AI call must NEVER be presentable as a successful
// check. Degrade loudly, never silently.

/** Machine-readable failure classes. The client branches on these, not on prose. */
export type AiFailureCode =
  | "QUOTA_EXHAUSTED"   // billing/credits/rate limit — user must top up or wait
  | "NOT_CONFIGURED"    // no usable API key on the server
  | "TIMEOUT"           // upstream took too long; retry is reasonable
  | "UNAUTHORIZED"      // key rejected/expired/permission denied
  | "BAD_RESPONSE"      // reached the model but output was empty/unparseable
  | "UPSTREAM_ERROR";   // anything else (5xx, network, unknown)

export interface AiFailure {
  code: AiFailureCode;
  /** HTTP status this failure should be reported as. */
  status: number;
  /** Plain-language, actionable message safe to show a non-technical user. */
  message: string;
  /** True when retrying the same request soon could plausibly succeed. */
  retryable: boolean;
  /** Raw upstream detail, for logs and debugging. Never contains the API key. */
  detail: string;
}

/**
 * Flatten an unknown thrown value into searchable text.
 * The @google/genai SDK throws ApiError whose useful content sits in `message`
 * as a JSON string; nested `error.message`/`status` also appear in some paths.
 */
function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const e = err as any;
  const parts: string[] = [];
  for (const v of [e.message, e.status, e.code, e.statusText, e?.error?.message, e?.error?.status]) {
    if (typeof v === "string" || typeof v === "number") parts.push(String(v));
  }
  // Some SDK errors carry the payload only on a nested response body.
  if (e.response && typeof e.response === "object") {
    for (const v of [e.response.status, e.response.statusText, e.response?.data?.error?.message]) {
      if (typeof v === "string" || typeof v === "number") parts.push(String(v));
    }
  }
  if (!parts.length) {
    try { parts.push(JSON.stringify(e)); } catch { parts.push(String(e)); }
  }
  return parts.join(" | ");
}

/**
 * Strip anything key-shaped before a detail string is logged or returned.
 * Cheap insurance: upstream errors sometimes echo the request URL, which can
 * carry ?key=... A leaked key in a log or an API response is not recoverable.
 */
export function redact(text: string): string {
  return text
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_\-]{10,}\b/g, "[REDACTED]")
    .replace(/("?api[_-]?key"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[REDACTED]");
}

/**
 * Classify any thrown AI error into a stable, user-safe failure descriptor.
 *
 * Order matters: quota is checked before generic 429/5xx handling because a
 * depleted-credits error is actionable in a specific way (top up billing)
 * that "try again later" would obscure.
 */
export function classifyAiError(err: unknown, opts?: { label?: string }): AiFailure {
  const raw = errorText(err);
  const text = raw.toLowerCase();
  const detail = redact(raw).slice(0, 500);
  const what = opts?.label ? `${opts.label} ` : "";

  // Quota / billing / rate limit. Covers both wordings that previously lived in
  // two separate regexes, plus the exact string Gemini returns when prepaid
  // credits run out.
  if (
    /resource_exhausted|quota|credits are depleted|rate.?limit|too many requests|\b429\b/.test(text)
  ) {
    return {
      code: "QUOTA_EXHAUSTED",
      status: 429,
      message:
        "The AI service has run out of credits or hit its usage limit, so this step could not run. " +
        "Top up the Gemini API billing (or wait for the limit to reset), then try again. " +
        "You can continue by entering these details manually.",
      retryable: true,
      detail,
    };
  }

  if (/timed out|timeout|etimedout|deadline_exceeded|abort/.test(text)) {
    return {
      code: "TIMEOUT",
      status: 504,
      message: `The AI service did not respond in time${what ? ` while ${opts!.label}` : ""}. Please try again.`,
      retryable: true,
      detail,
    };
  }

  // Transient model overload / capacity (HTTP 503 "high demand" / UNAVAILABLE).
  // Distinct from quota: no billing action helps — the model is momentarily busy,
  // so retrying (or letting the server fail over to another model) is the fix.
  if (/unavailable|overloaded|experiencing high demand|try again later|\b503\b/.test(text)) {
    return {
      code: "UPSTREAM_ERROR",
      status: 503,
      message:
        `The AI model is temporarily overloaded${what ? ` (${opts!.label})` : ""} due to high demand. ` +
        "This is usually brief — please retry in a moment. You can also continue by entering the details manually.",
      retryable: true,
      detail,
    };
  }

  if (
    /api[_ -]?key not valid|invalid api key|api key expired|permission_denied|unauthenticated|unauthorized|\b401\b|\b403\b/.test(text)
  ) {
    return {
      code: "UNAUTHORIZED",
      status: 502,
      message:
        "The AI service rejected the server's credentials. The API key may be invalid or expired — " +
        "please check the server configuration. You can continue by entering these details manually.",
      retryable: false,
      detail,
    };
  }

  if (/empty response|unparseable|could not parse|unexpected token|json/.test(text)) {
    return {
      code: "BAD_RESPONSE",
      status: 502,
      message:
        "The AI service returned a response this app could not read. Please try again — " +
        "if it keeps happening, enter the details manually.",
      retryable: true,
      detail,
    };
  }

  return {
    code: "UPSTREAM_ERROR",
    status: 502,
    message:
      `The AI service is temporarily unavailable${what ? ` (${opts!.label})` : ""}. ` +
      "Please try again in a moment, or continue by entering the details manually.",
    retryable: true,
    detail,
  };
}

/** The failure to report when no usable API key is configured on the server. */
export function notConfiguredFailure(label?: string): AiFailure {
  return {
    code: "NOT_CONFIGURED",
    status: 503,
    message:
      `AI features are not configured on this server${label ? ` (${label})` : ""}, so this step could not run. ` +
      "Set GEMINI_API_KEY to enable it. You can continue by entering the details manually.",
    retryable: false,
    detail: "GEMINI_API_KEY missing or placeholder",
  };
}

/**
 * The JSON body every AI endpoint returns on failure. Uniform shape means the
 * frontend needs exactly one error-rendering path instead of eleven.
 */
export function aiErrorBody(f: AiFailure) {
  return {
    error: f.message,
    errorCode: f.code,
    retryable: f.retryable,
    aiAvailable: false,
    detail: f.detail,
  };
}

/**
 * Marks a response whose AI step did NOT run, so the client can never mistake a
 * fallback for a verified result. `aiStatus: "unavailable"` is the inverse of
 * the implicit "everything worked" that an unflagged HTTP 200 communicates.
 */
export function degradedMeta(f: AiFailure) {
  return {
    aiStatus: "unavailable" as const,
    aiAvailable: false,
    degraded: true,
    errorCode: f.code,
    degradedReason: f.message,
    retryable: f.retryable,
  };
}

/** Marks a response produced by a fully successful AI call. */
export const OK_META = {
  aiStatus: "ok" as const,
  aiAvailable: true,
  degraded: false,
};

/**
 * Bound any promise so a stuck upstream call cannot hang a client spinner
 * forever. Rejects with a message classifyAiError maps to TIMEOUT.
 *
 * NOTE: this races rather than cancels — the underlying request may continue in
 * the background. That is deliberate: the SDK gives no cancellation handle, and
 * returning an honest timeout to the user beats waiting indefinitely.
 */
export function withAiTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Default ceiling for a single AI call. Overridable per call site. */
export const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60000;

/**
 * One-line structured log for an AI failure. Keeps the console greppable and
 * guarantees the detail passes through redact() before it is written.
 */
export function logAiFailure(where: string, f: AiFailure): void {
  console.warn(`[ai:${f.code}] ${where} -> HTTP ${f.status}${f.retryable ? " (retryable)" : ""}: ${f.detail}`);
}
