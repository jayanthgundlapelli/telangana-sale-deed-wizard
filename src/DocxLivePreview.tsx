// DocxLivePreview.tsx
// -----------------------------------------------------------------------------
// Renders the ACTUAL filled .docx (the exact bytes /api/generate-document
// produced and /api/export-document ships) inside a scroll panel, scaled to fit
// the panel width — so what the user reviews on screen is byte-for-byte what
// downloads: real tables, centered/bold headings, correct fonts, and true page
// breaks. A flattened plain-text preview can show none of these.
//
// Used by BOTH the Auto-Fill Draft (Step 4) and the Stamp Preview (Step 6) so
// the two previews are pixel-identical and share one (carefully measured) code
// path. On any parse/render failure it calls onError so the caller can fall back
// to its own text view; the panel is never left silently blank.
//
// IMPORTANT — docx-preview 0.4.0 DOM contract (verified against the shipped
// dist): renderAsync(..., {className:"docxpv", inWrapper:true}) emits
//     <div class="docxpv-wrapper"> <section class="docxpv">…page 1…</section>
//                                  <section class="docxpv">…page 2…</section> … </div>
// The WRAPPER's height spans ALL pages; a single <section> is only ONE page.
// Measuring a section (or the wrong `.docx-wrapper` class) sizes the container
// to one page and clips the rest — which reads as an empty preview when page 1
// opens with the 5.8" stamp reserve. We therefore measure the wrapper.
// -----------------------------------------------------------------------------

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { renderAsync as renderDocxAsync } from "docx-preview";

// Decode base64 (raw OR data-URL) into bytes for in-browser rendering.
function base64ToUint8Array(b64: string): Uint8Array {
  const raw = (b64 || "").replace(/^data:[^,]+,/, "");
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export interface DocxLivePreviewProps {
  /** base64 (raw or data-URL) of the filled .docx to render. */
  docxBase64: string;
  /** Tailwind max-height class for the scroll panel (default max-h-[720px]). */
  maxHeightClass?: string;
  /** Called once if docx-preview cannot parse/render the bytes. */
  onError?: () => void;
  /** Called after a successful render (e.g. to clear a parent error flag). */
  onRendered?: () => void;
}

export default function DocxLivePreview({
  docxBase64,
  maxHeightClass = "max-h-[720px]",
  onError,
  onRendered,
}: DocxLivePreviewProps) {
  const panelRef = useRef<HTMLDivElement | null>(null); // scroll container (measures avail width)
  const hostRef = useRef<HTMLDivElement | null>(null); // docx-preview mounts here
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);

  // Keep the latest callbacks in refs so the render effect only depends on the
  // docx bytes (callers usually pass fresh arrow fns each render).
  const onErrorRef = useRef(onError);
  const onRenderedRef = useRef(onRendered);
  onErrorRef.current = onError;
  onRenderedRef.current = onRendered;

  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    // The wrapper contains ALL pages; measure it, not a single section.
    const wrap =
      host.querySelector<HTMLElement>(".docxpv-wrapper") ||
      (host.firstElementChild as HTMLElement | null);
    if (wrap && (wrap.offsetWidth || wrap.offsetHeight)) {
      setDims({ w: wrap.offsetWidth || 0, h: wrap.offsetHeight || 0 });
    }
  }, []);

  // ---- Render the .docx into the host whenever the bytes change. ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !docxBase64) return;
    let cancelled = false;
    host.innerHTML = "";
    (async () => {
      try {
        const bytes = base64ToUint8Array(docxBase64);
        const blob = new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        if (cancelled) return;
        await renderDocxAsync(blob, host, undefined, {
          className: "docxpv",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          useBase64URL: true,
        });
        if (cancelled) return;
        measure();
        // A second measure on the next frame catches late web-font/table layout.
        requestAnimationFrame(() => {
          if (!cancelled) measure();
        });
        onRenderedRef.current?.();
      } catch (e) {
        console.warn("docx-preview render failed; caller should show text fallback:", e);
        if (!cancelled) onErrorRef.current?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docxBase64, measure]);

  // ---- Fit the rendered page width to the panel (never upscale past 1:1). ----
  const recomputeScale = useCallback(() => {
    const panel = panelRef.current;
    if (!panel || !dims.w) return;
    const cs = window.getComputedStyle(panel);
    const padX = parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
    const avail = Math.max(0, panel.clientWidth - padX);
    setScale(avail > 0 ? Math.min(1, avail / dims.w) : 1);
  }, [dims.w]);

  useLayoutEffect(() => {
    recomputeScale();
  }, [recomputeScale, dims.w]);

  // Recompute on panel resize (responsive) — ResizeObserver is robust to layout
  // shifts the window 'resize' event misses (e.g. side panel opening).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const ro = new ResizeObserver(() => recomputeScale());
    ro.observe(panel);
    window.addEventListener("resize", recomputeScale);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recomputeScale);
    };
  }, [recomputeScale]);

  return (
    <div
      ref={panelRef}
      className={`bg-slate-200/70 rounded-xl p-5 flex justify-center overflow-auto ${maxHeightClass}`}
    >
      {/* Outer box reserves the SCALED footprint so the scroll area is correct;
          the inner host is transform-scaled from its top-left. */}
      <div
        style={{
          width: dims.w ? `${dims.w * scale}px` : "100%",
          height: dims.h ? `${dims.h * scale}px` : "auto",
        }}
      >
        <div
          ref={hostRef}
          className="docxpv-host"
          style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
        />
      </div>
    </div>
  );
}
