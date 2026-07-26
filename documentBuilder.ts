// documentBuilder.ts
// Generates the final Sale Deed as a Microsoft Word (.docx) document applying the
// Telangana stamp-paper formatting spec EXACTLY, regardless of the source template's
// own formatting:
//
//   - Page size : A4 (210mm x 297mm)
//   - Font      : Times New Roman, 14pt
//   - Page 1    : body content starts 5.8" from the top edge (space reserved above
//                 for the pre-printed stamp logo + header). L/R padding 0.75", bottom 1".
//   - Page 2..n : top 1", left 0.75", right 0.75", bottom 1".
//
// The 5.8" first-page offset is achieved with a one-time spacer before the first
// paragraph (4.8" on top of the 1" section margin = 5.8"), which is content-independent
// and renders identically in Word, LibreOffice, and Google Docs.

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  PageBreak,
  ImageRun,
  AlignmentType,
  convertInchesToTwip,
  convertMillimetersToTwip,
} from "docx";

export interface DeedFormatOptions {
  /** Inches from the top edge of PAGE 1 where the body should begin. Default 5.8. */
  firstPageBodyStartInches?: number;
  /** Standard top margin (inches) applied to pages 2..n. Default 1. */
  topMarginInches?: number;
  leftMarginInches?: number;
  rightMarginInches?: number;
  bottomMarginInches?: number;
  /** Point size of the body font. Default 14. */
  fontSizePt?: number;
  fontFamily?: string;
  /**
   * Optional registration-plan image (PNG) to append as a FINAL full page after the
   * deed body. Pass the raw base64 (no data-URL prefix). When present, a page break
   * plus a centered, page-fitted image is added. The .docx (and any PDF derived from
   * it) then carries the plan as its last page.
   */
  planImagePngBase64?: string;
  /** Natural pixel dimensions of the plan image, used to preserve aspect ratio. */
  planImageWidthPx?: number;
  planImageHeightPx?: number;
}

const DEFAULTS: Required<
  Omit<DeedFormatOptions, "planImagePngBase64" | "planImageWidthPx" | "planImageHeightPx">
> = {
  firstPageBodyStartInches: 5.8,
  topMarginInches: 1,
  leftMarginInches: 0.75,
  rightMarginInches: 0.75,
  bottomMarginInches: 1,
  fontSizePt: 14,
  fontFamily: "Times New Roman",
};

// Heuristic: is this line a heading/title that should be bold + centered?
function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.length > 70) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  // All-caps line with a few words, or a well-known deed heading keyword.
  const isAllCaps = letters.length >= 3 && letters === letters.toUpperCase();
  const keyword = /^(SALE DEED|DEED OF|SCHEDULE|BOUNDARIES|IN WITNESS|NOW THIS DEED|WHEREAS)\b/i.test(t);
  return isAllCaps || keyword;
}

// Sub-heading: label lines ending in ':' (e.g. "THE EXECUTANT / SELLER:")
function isSubHeadingLine(line: string): boolean {
  const t = line.trim();
  return /:$/.test(t) && t.length <= 60 && t === t.toUpperCase();
}

/**
 * Convert merged deed TEXT (placeholders already resolved) into a formatted .docx Buffer.
 */
export async function buildDeedDocx(
  mergedText: string,
  options: DeedFormatOptions = {}
): Promise<Buffer> {
  const opts = { ...DEFAULTS, ...options };
  const halfPointSize = Math.round(opts.fontSizePt * 2); // docx sizes are in half-points

  const lines = (mergedText || "").replace(/\r\n/g, "\n").split("\n");

  // Spacer to push the first line of page 1 down to `firstPageBodyStartInches`.
  // The section top margin already accounts for `topMarginInches`.
  const spacerTwips = convertInchesToTwip(
    Math.max(0, opts.firstPageBodyStartInches - opts.topMarginInches)
  );

  const paragraphs: Paragraph[] = [];
  let firstParagraphEmitted = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, "");

    // Explicit page-break marker emitted by the transcription/merge step so the
    // generated deed paginates to the SAME page count as the uploaded template.
    if (/^-{2,}\s*PAGE\s*BREAK\s*-{2,}$/i.test(line.trim())) {
      paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
      firstParagraphEmitted = true;
      continue;
    }

    const heading = isHeadingLine(line);
    const subHeading = !heading && isSubHeadingLine(line);

    const runs = line.trim().length
      ? [new TextRun({ text: line, bold: heading || subHeading })]
      : [new TextRun({ text: "" })];

    const para = new Paragraph({
      children: runs,
      alignment: heading
        ? AlignmentType.CENTER
        : line.trim().length
        ? AlignmentType.JUSTIFIED
        : AlignmentType.LEFT,
      spacing: {
        // First emitted paragraph carries the big top spacer for the stamp/header area.
        before: !firstParagraphEmitted ? spacerTwips : heading ? 240 : 60,
        after: heading ? 160 : 120,
        line: 276, // ~1.15 line spacing for legibility
      },
    });

    paragraphs.push(para);
    firstParagraphEmitted = true;
  }

  if (paragraphs.length === 0) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: "" })],
        spacing: { before: spacerTwips },
      })
    );
  }

  // ── Append the registration plan as a FINAL full page (if provided) ──────────
  // The one-pager plan is rendered on the client as an SVG, rasterised there to a
  // PNG (Word/PDF cannot embed a raw SVG reliably), and passed here as base64. We
  // add a page break then a centered image fitted to the usable content area, so
  // both the .docx and any PDF derived from it carry the plan as their last page.
  if (opts.planImagePngBase64 && opts.planImagePngBase64.trim().length > 0) {
    try {
      const imgW = opts.planImageWidthPx && opts.planImageWidthPx > 0 ? opts.planImageWidthPx : 800;
      const imgH = opts.planImageHeightPx && opts.planImageHeightPx > 0 ? opts.planImageHeightPx : 1131;
      // Usable content area (A4 minus the pages-2..n margins), in px at 96 DPI.
      const A4_WIDTH_IN = 210 / 25.4; // 8.2677"
      const A4_HEIGHT_IN = 297 / 25.4; // 11.6929"
      const usableWpx = (A4_WIDTH_IN - opts.leftMarginInches - opts.rightMarginInches) * 96;
      const usableHpx = (A4_HEIGHT_IN - opts.topMarginInches - opts.bottomMarginInches) * 96;
      const scale = Math.min(usableWpx / imgW, usableHpx / imgH);
      const dispW = Math.max(1, Math.round(imgW * scale));
      const dispH = Math.max(1, Math.round(imgH * scale));
      const data = Buffer.from(opts.planImagePngBase64.replace(/^data:[^,]+,/, ""), "base64");

      paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 0, line: 240 },
          children: [
            new ImageRun({
              type: "png",
              data,
              transformation: { width: dispW, height: dispH },
            }),
          ],
        })
      );
    } catch (e: any) {
      console.warn("Failed to append plan image page:", e?.message || e);
      // Non-fatal: the deed is still produced without the plan page.
    }
  }

  const doc = new Document({
    creator: "Telangana Sale Deed Wizard",
    title: "Sale Deed",
    styles: {
      default: {
        document: {
          run: { font: opts.fontFamily, size: halfPointSize },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertMillimetersToTwip(210), // A4 width
              height: convertMillimetersToTwip(297), // A4 height
            },
            margin: {
              top: convertInchesToTwip(opts.topMarginInches),
              right: convertInchesToTwip(opts.rightMarginInches),
              bottom: convertInchesToTwip(opts.bottomMarginInches),
              left: convertInchesToTwip(opts.leftMarginInches),
            },
          },
        },
        children: paragraphs,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// Deterministic placeholder merge — exact, no paraphrasing, no hallucination.
// Unknown placeholders are left intact so the Re-Verify step can flag them.
export function mergePlaceholders(
  templateText: string,
  replacements: Record<string, string>
): string {
  let result = templateText || "";
  for (const [placeholder, value] of Object.entries(replacements)) {
    const regex = new RegExp(
      placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"),
      "g"
    );
    result = result.replace(regex, value ?? "");
  }
  return result;
}
