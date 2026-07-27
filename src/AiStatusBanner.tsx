// The one place an AI failure or degradation is shown to the user.
//
// Why a component rather than inline JSX: the app had ONE working error banner
// (planError) and one working warning banner (plan notVerified), while the
// general `error` state was set from 23 different places and rendered nowhere at
// all. Anything that went wrong outside the plan step failed silently. This
// generalises those two working patterns so every surface reports failures the
// same way, and so a new failure mode is styled correctly for free.
//
// Styling deliberately reuses the existing palette (#0a4d4a teal actions, red-50
// /red-200 for errors, slate for "not verified", amber for degraded) so the
// alignment, fonts, weights and colours match the surrounding UI exactly.
import { AlertTriangle, RefreshCw, X, Info } from "lucide-react";
import type { ApiFailure } from "./aiError";

type Severity = "error" | "warning";

interface Props {
  failure: ApiFailure | null;
  /** Shown as the bold first line. Defaults per severity. */
  title?: string;
  /** Rendered as a Retry button when the failure is retryable. */
  onRetry?: () => void;
  /** Rendered as a dismiss (X) button. */
  onDismiss?: () => void;
  /**
   * "error" = the step did not happen.
   * "warning" = the step produced a real result WITHOUT AI, which the user must
   *   know about but which does not block them.
   */
  severity?: Severity;
  className?: string;
}

export default function AiStatusBanner({
  failure,
  title,
  onRetry,
  onDismiss,
  severity = "error",
  className = "",
}: Props) {
  if (!failure) return null;

  const isWarn = severity === "warning";
  const box = isWarn
    ? "bg-amber-50 border-amber-300"
    : "bg-red-50 border-red-200";
  const head = isWarn ? "text-amber-900" : "text-red-900";
  const bodyText = isWarn ? "text-amber-800" : "text-red-800";
  const iconColor = isWarn ? "text-amber-600" : "text-red-500";

  const heading =
    title ||
    (isWarn
      ? "Completed without AI assistance"
      : failure.code === "QUOTA_EXHAUSTED"
      ? "AI credits exhausted"
      : failure.code === "NOT_CONFIGURED"
      ? "AI features not configured"
      : failure.code === "TIMEOUT"
      ? "The AI service timed out"
      : failure.code === "NETWORK"
      ? "Could not reach the server"
      : "This step could not be completed");

  return (
    <div
      // role=alert so the message is announced, not just drawn — a silent
      // failure for a screen-reader user is the same bug in a different form.
      role="alert"
      className={`border rounded-xl p-3.5 space-y-2 ${box} ${className}`}
    >
      <div className="flex items-start gap-2.5">
        {isWarn ? (
          <Info className={`w-4 h-4 shrink-0 mt-0.5 ${iconColor}`} />
        ) : (
          <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${iconColor}`} />
        )}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={`text-xs font-extrabold ${head}`}>{heading}</p>
            {/* The machine code is shown small: meaningless to most users, but
                it is what makes a support request actionable. */}
            <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-white/70 border border-current/20 text-slate-500">
              {failure.code}
            </span>
          </div>
          <p className={`text-[11px] font-semibold leading-relaxed ${bodyText}`}>
            {failure.message}
          </p>
          {failure.hint && (
            <p className="text-[10px] text-slate-600 leading-relaxed">{failure.hint}</p>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 text-slate-400 hover:text-slate-700 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Only offer a retry when retrying could actually help. Offering it on an
          UNAUTHORIZED failure just invites the user to click forever. */}
      {onRetry && failure.retryable && (
        <div className="pl-7">
          <button
            onClick={onRetry}
            className="text-[11px] font-extrabold text-white bg-[#0a4d4a] hover:bg-[#0d5f5b] px-3 py-1.5 rounded flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}
    </div>
  );
}
