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
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
} from "docx";
import { stripInvalidXmlChars } from "./templateFiller";
import { promises as fsp } from "fs";
import path from "path";

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

  // Strip characters that are illegal in XML 1.0 (NUL, vertical tab, form feed,
  // other C0/C1 controls, lone surrogates) BEFORE they reach a <w:t> run — else
  // Word rejects the file with "problems with the contents … /word/document.xml".
  const lines = stripInvalidXmlChars((mergedText || "").replace(/\r\n/g, "\n")).split("\n");

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

  return packDocxClean(doc);
}

// -----------------------------------------------------------------------------
// Telugu translation export (Feature #5): a SEPARATE, standalone .docx carrying
// ONLY the Telugu translation of the deed, set in the "Sree Krushnadevaraya"
// Telugu font. The font file is shipped in the repo (public/fonts — served to
// the browser AND read here on the server) under its own SIL OFL license, and
// EMBEDDED into the .docx (docx library's `fonts` option) so the document
// renders in that exact typeface even on a machine that never installed it.
// -----------------------------------------------------------------------------

const TELUGU_FONT_NAME = "Sree Krushnadevaraya";
// The font's ON-DISK location differs between dev and the built/production
// image, so — mirroring the candidate-path approach already used for the
// `soffice` binary lookup above — try every layout this app actually runs in.
// Both are resolved relative to process.cwd() (NOT `__dirname`/import.meta.url:
// this file is ESM (package.json "type":"module") under `npx tsx`, where
// `__dirname` does not exist, and it is bundled to CJS by esbuild for
// production — a single cwd-relative strategy works correctly in both):
//   1. `npx tsx server.ts` from the repo root (dev): CWD is the repo root,
//      where the font lives at public/fonts/... (source location).
//   2. The bundled `dist/server.cjs` (prod, Dockerfile's CMD): the container's
//      WORKDIR/CWD is /app, and `vite build` copies public/* into dist/, so the
//      font ends up at dist/fonts/... — NOT public/fonts/... (only dist/ and
//      templates/ are copied into the runtime image).
const TELUGU_FONT_CANDIDATES = [
  path.join(process.cwd(), "public", "fonts", "SreeKrushnadevaraya-Regular.ttf"),
  path.join(process.cwd(), "dist", "fonts", "SreeKrushnadevaraya-Regular.ttf"),
];

let cachedTeluguFontBuffer: Buffer | null | undefined; // undefined = not yet attempted

// Best-effort font load, cached after the first successful/failed attempt.
// Returns null (never throws) when the font file cannot be found in ANY
// candidate location, so callers can still produce a Telugu .docx — Word will
// just substitute a fallback font for it rather than the document failing to
// generate at all.
async function loadTeluguFontBuffer(): Promise<Buffer | null> {
  if (cachedTeluguFontBuffer !== undefined) return cachedTeluguFontBuffer;
  for (const candidate of TELUGU_FONT_CANDIDATES) {
    try {
      cachedTeluguFontBuffer = await fsp.readFile(candidate);
      return cachedTeluguFontBuffer;
    } catch {
      // try the next candidate
    }
  }
  console.warn(
    `Telugu font (Sree Krushnadevaraya) not found in any of: ${TELUGU_FONT_CANDIDATES.join(", ")} — Telugu .docx will use a fallback font.`
  );
  cachedTeluguFontBuffer = null;
  return cachedTeluguFontBuffer;
}

/**
 * Build a STANDALONE .docx containing ONLY the supplied Telugu text, formatted
 * to the same A4/margins/spacer layout as the main deed (so it visually matches
 * the English original), but in the Sree Krushnadevaraya Telugu font — embedded
 * into the file itself so it displays correctly for any recipient.
 */
export async function buildTeluguDeedDocx(
  teluguText: string,
  options: DeedFormatOptions = {}
): Promise<Buffer> {
  const opts = { ...DEFAULTS, ...options, fontFamily: TELUGU_FONT_NAME };
  const halfPointSize = Math.round(opts.fontSizePt * 2);

  const lines = stripInvalidXmlChars((teluguText || "").replace(/\r\n/g, "\n")).split("\n");
  const spacerTwips = convertInchesToTwip(
    Math.max(0, opts.firstPageBodyStartInches - opts.topMarginInches)
  );

  const paragraphs: Paragraph[] = [];
  let firstParagraphEmitted = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, "");

    if (/^-{2,}\s*PAGE\s*BREAK\s*-{2,}$/i.test(line.trim())) {
      paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
      firstParagraphEmitted = true;
      continue;
    }

    const heading = isHeadingLine(line);
    const subHeading = !heading && isSubHeadingLine(line);

    const runs = line.trim().length
      ? [new TextRun({ text: line, bold: heading || subHeading, font: TELUGU_FONT_NAME })]
      : [new TextRun({ text: "", font: TELUGU_FONT_NAME })];

    paragraphs.push(
      new Paragraph({
        children: runs,
        alignment: heading
          ? AlignmentType.CENTER
          : line.trim().length
          ? AlignmentType.JUSTIFIED
          : AlignmentType.LEFT,
        spacing: {
          before: !firstParagraphEmitted ? spacerTwips : heading ? 240 : 60,
          after: heading ? 160 : 120,
          line: 360, // Telugu vowel signs/conjuncts need more line height than Latin text
        },
      })
    );
    firstParagraphEmitted = true;
  }

  if (paragraphs.length === 0) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: "", font: TELUGU_FONT_NAME })],
        spacing: { before: spacerTwips },
      })
    );
  }

  const teluguFontBuffer = await loadTeluguFontBuffer();

  const doc = new Document({
    creator: "Telangana Sale Deed Wizard",
    title: "Sale Deed (Telugu Translation)",
    ...(teluguFontBuffer ? { fonts: [{ name: TELUGU_FONT_NAME, data: teluguFontBuffer }] } : {}),
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
              width: convertMillimetersToTwip(210),
              height: convertMillimetersToTwip(297),
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

  return packDocxClean(doc);
}

// -----------------------------------------------------------------------------
// Append the registration plan as a FINAL image page INTO AN EXISTING .docx,
// WITHOUT rebuilding it — so an uploaded template that was filled in place keeps
// its exact fonts / margins / tables / page setup, and merely gains one more page.
//
// We manipulate the OOXML zip directly (JSZip): add the JPEG to word/media, wire a
// relationship, ensure the content-type + required namespaces exist, then insert a
// page-break paragraph + a centred <w:drawing> just before the body's trailing
// <w:sectPr>. The image is fitted to the template's own usable page area (parsed
// from that sectPr), preserving aspect ratio.
// -----------------------------------------------------------------------------
export interface AppendPlanOptions {
  /** Base64 (data-URL or raw) of the plan image to embed. JPEG recommended. */
  imageBase64: string;
  /** Natural pixel width/height of the image (for aspect ratio). */
  imageWidthPx?: number;
  imageHeightPx?: number;
}

// EMU (English Metric Units): 914400 per inch, 635 per twip, 9525 per px @96dpi.
const EMU_PER_TWIP = 635;
const EMU_PER_PX = 9525;

// Parse the template's own usable page area (width/height in EMU) from the body
// section's <w:sectPr> so the appended image fits that template — not a guess.
function usablePageEmu(documentXml: string): { availW: number; availH: number } {
  // A4 portrait defaults (twips) with 0.75" L/R, 1" T/B margins.
  let pgW = 11906, pgH = 16838, mL = 1080, mR = 1080, mT = 1440, mB = 1440;
  const sect = documentXml.lastIndexOf("<w:sectPr");
  if (sect !== -1) {
    let end = documentXml.indexOf("</w:sectPr>", sect);
    end = end === -1 ? documentXml.length : end + "</w:sectPr>".length;
    const seg = documentXml.slice(sect, end);
    const wsz = seg.match(/<w:pgSz\b[^>]*\bw:w="(\d+)"/);
    const hsz = seg.match(/<w:pgSz\b[^>]*\bw:h="(\d+)"/);
    if (wsz) pgW = parseInt(wsz[1], 10);
    if (hsz) pgH = parseInt(hsz[1], 10);
    const mar = seg.match(/<w:pgMar\b[^>]*\/?>/);
    if (mar) {
      const g = (k: string) => {
        const m = mar[0].match(new RegExp(`\\bw:${k}="(-?\\d+)"`));
        return m ? parseInt(m[1], 10) : null;
      };
      mL = g("left") ?? mL;
      mR = g("right") ?? mR;
      mT = g("top") ?? mT;
      mB = g("bottom") ?? mB;
    }
  }
  return {
    availW: Math.max(1, pgW - mL - mR) * EMU_PER_TWIP,
    availH: Math.max(1, pgH - mT - mB) * EMU_PER_TWIP,
  };
}

// JSZip's `zip.file(path, data)` defaults to `createFolders: true`, which
// silently inserts a zero-byte directory entry (e.g. "word/") for every parent
// path segment that doesn't already have one explicitly in the archive. Real
// Word/LibreOffice-authored .docx zips NEVER contain directory entries — only
// flat file parts — and Word's OPC parser can reject a package that does,
// surfacing as "problems with the contents" even though the XML inside is
// perfectly well-formed. Every helper in this module re-saves an uploaded/
// generated .docx via zip.file(...), so call this immediately before
// generateAsync() to strip any directory entries JSZip introduced.
function stripZipDirectoryEntries(zip: import("jszip")): void {
  // NOTE: zip.remove(path) is NOT safe here — for a path ending in "/" it
  // treats it as a folder and recursively deletes every file whose name
  // starts with that prefix (e.g. remove("word/") would also delete
  // "word/document.xml"). Delete straight from the internal files map instead,
  // which only removes the exact zero-byte directory-entry keys.
  const files = (zip as any).files as Record<string, { dir?: boolean }>;
  for (const relPath of Object.keys(files)) {
    if (relPath.endsWith("/") && files[relPath]?.dir) delete files[relPath];
  }
}

// The `docx` library's own `Packer.toBuffer()` builds its zip package the same
// way (via JSZip with default createFolders: true), so buffers it produces
// ALSO come out with stray zero-byte directory entries — the exact same
// "problems with the contents" failure mode stripZipDirectoryEntries() above
// exists to fix, just one layer further from our own code. Every document
// built from scratch with `new Document(...)` (buildDeedDocx,
// buildTeluguDeedDocx, buildVerificationReportDocx) must go through this
// instead of calling Packer.toBuffer(doc) directly: re-load the packed buffer
// with JSZip, strip the directory entries, and re-save.
async function packDocxClean(doc: Document): Promise<Buffer> {
  const raw = await Packer.toBuffer(doc);
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(raw);
  stripZipDirectoryEntries(zip);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export async function appendPlanPageToDocx(
  docxBuffer: Buffer,
  opts: AppendPlanOptions
): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(docxBuffer);

  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a valid .docx (missing word/document.xml).");
  let xml = await docFile.async("string");

  // 1) Image bytes + fitted size.
  const raw = (opts.imageBase64 || "").replace(/^data:[^,]+,/, "");
  const imgData = Buffer.from(raw, "base64");
  if (imgData.length === 0) return docxBuffer; // nothing to add
  const imgWpx = opts.imageWidthPx && opts.imageWidthPx > 0 ? opts.imageWidthPx : 800;
  const imgHpx = opts.imageHeightPx && opts.imageHeightPx > 0 ? opts.imageHeightPx : 1131;
  const { availW, availH } = usablePageEmu(xml);
  const natW = imgWpx * EMU_PER_PX;
  const natH = imgHpx * EMU_PER_PX;
  const scale = Math.min(availW / natW, availH / natH);
  const cx = Math.max(1, Math.round(natW * scale));
  const cy = Math.max(1, Math.round(natH * scale));

  // 2) Add the media file (unique name to avoid clobbering template media).
  const imgName = "registration-plan-appended.jpg";
  zip.file(`word/media/${imgName}`, imgData);

  // 3) Ensure [Content_Types].xml declares the jpg extension.
  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ct = await ctFile.async("string");
    if (!/<Default\b[^>]*Extension="jpe?g"/i.test(ct)) {
      ct = ct.replace(/<\/Types>/, '<Default Extension="jpg" ContentType="image/jpeg"/></Types>');
      zip.file("[Content_Types].xml", ct);
    }
  }

  // 4) Wire a relationship in word/_rels/document.xml.rels (unique rId).
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  let rId = "rId900001";
  if (relsFile) {
    let rels = await relsFile.async("string");
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => parseInt(m[1], 10));
    rId = "rId" + ((ids.length ? Math.max(...ids) : 0) + 1);
    rels = rels.replace(
      /<\/Relationships>/,
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${imgName}"/></Relationships>`
    );
    zip.file(relsPath, rels);
  }

  // 5) Ensure the drawing namespaces exist on <w:document>.
  xml = xml.replace(/<w:document\b([^>]*)>/, (_m, attrs) => {
    let a = attrs as string;
    if (!/xmlns:r=/.test(a)) a += ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    if (!/xmlns:wp=/.test(a)) a += ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    return `<w:document${a}>`;
  });

  // 6) Build the page-break + centred image paragraphs.
  const drawingId = 424242;
  const planXml =
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` +
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${drawingId}" name="RegistrationPlan"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${imgName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline>` +
    `</w:drawing></w:r></w:p>`;

  // 7) Insert before the body's trailing <w:sectPr> (which must remain last in
  //    <w:body>). If there is no body-level sectPr, insert before </w:body>.
  const bodyClose = xml.lastIndexOf("</w:body>");
  const lastSect = xml.lastIndexOf("<w:sectPr");
  const lastParaClose = xml.lastIndexOf("</w:p>");
  let insertAt: number;
  if (lastSect !== -1 && lastSect < bodyClose && lastSect > lastParaClose) {
    insertAt = lastSect; // body-level sectPr → put our pages just before it
  } else {
    insertAt = bodyClose === -1 ? xml.length : bodyClose;
  }
  xml = xml.slice(0, insertAt) + planXml + xml.slice(insertAt);
  zip.file("word/document.xml", xml);
  stripZipDirectoryEntries(zip);

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export interface AppendEditablePlanOptions {
  /** Structured plan data as returned by the plan-generation endpoint. */
  plan?: any | null;
  /** Same "details" shape used to render the image version (property/executants/claimants). */
  details?: any | null;
  /** Same free-text-prompt-derived edits object used by the image version, so the
   *  editable export mirrors whatever the user already asked for. */
  edits?: any | null;
}

// Editable counterpart to appendPlanPageToDocx: instead of rasterising the plan
// to one flat picture, this emits native Word DrawingML shapes (text boxes for
// every label, a freeform polygon for the plot outline, rectangles for road
// bands/structures, primitives for the north arrow) so the resulting page can be
// edited directly in Word — retype a dimension, drag a boundary vertex, delete a
// line. This is an ADDITIONAL export path; appendPlanPageToDocx (the image
// version) is left untouched and remains the default/fallback, since Word/
// LibreOffice rendering of the shapes below has not been visually verified in
// this environment (no LibreOffice/Word available here) — only XML well-
// formedness and coordinate math have been checked.
export async function appendEditablePlanPageToDocx(
  docxBuffer: Buffer,
  opts: AppendEditablePlanOptions
): Promise<Buffer> {
  const { buildEditablePlanDrawingXml } = await import("./planDocxRenderer");
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(docxBuffer);

  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a valid .docx (missing word/document.xml).");
  let xml = await docFile.async("string");

  const { availW, availH } = usablePageEmu(xml);

  const drawingXml = buildEditablePlanDrawingXml({
    plan: opts.plan,
    details: opts.details,
    edits: opts.edits,
    availWEmu: availW,
    availHEmu: availH,
  });
  if (!drawingXml) return docxBuffer; // nothing to add

  // Ensure the namespaces our shapes rely on exist on <w:document>. (wps: is
  // declared locally on each <wps:wsp> tag, so it doesn't need to be here.)
  xml = xml.replace(/<w:document\b([^>]*)>/, (_m, attrs) => {
    let a = attrs as string;
    if (!/xmlns:r=/.test(a)) a += ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    if (!/xmlns:wp=/.test(a)) a += ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    return `<w:document${a}>`;
  });

  // Page-break, then ONE paragraph holding every anchored shape (their absolute
  // page-relative positioning means paragraph placement itself doesn't matter,
  // only that it lands on its own page after the break).
  const planXml =
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` +
    `<w:p>${drawingXml}</w:p>`;

  const bodyClose = xml.lastIndexOf("</w:body>");
  const lastSect = xml.lastIndexOf("<w:sectPr");
  const lastParaClose = xml.lastIndexOf("</w:p>");
  let insertAt: number;
  if (lastSect !== -1 && lastSect < bodyClose && lastSect > lastParaClose) {
    insertAt = lastSect;
  } else {
    insertAt = bodyClose === -1 ? xml.length : bodyClose;
  }
  xml = xml.slice(0, insertAt) + planXml + xml.slice(insertAt);
  zip.file("word/document.xml", xml);
  stripZipDirectoryEntries(zip);

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export interface AppendImage {
  /** Base64 (data-URL or raw) of the image. */
  base64: string;
  /** MIME type, e.g. image/jpeg or image/png. Non-image types are skipped. */
  mimeType?: string;
  /** Optional caption drawn under the image. */
  caption?: string;
}

// Append ALL supplied images onto ONE final page of an existing .docx (used for
// the uploaded Aadhaar/PAN card scans, placed after the deed and the plan page).
// Images are stacked and each fitted so the whole set fits within a single page's
// usable area. Non-image MIME types (e.g. PDF) are skipped — they cannot be
// embedded as a picture without rasterisation.
export async function appendImagesPageToDocx(
  docxBuffer: Buffer,
  images: AppendImage[],
  opts: { pageTitle?: string } = {}
): Promise<Buffer> {
  const usable = (images || []).filter(
    (im) => im && typeof im.base64 === "string" && im.base64.trim() && /^image\//i.test(im.mimeType || "image/jpeg")
  );
  if (usable.length === 0) return docxBuffer;

  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) return docxBuffer;
  let xml = await docFile.async("string");

  const { availW, availH } = usablePageEmu(xml);
  // Reserve room for a page title + per-image gaps; split the remaining height
  // evenly so every card fits on the single page.
  const titleH = opts.pageTitle ? 360000 : 0; // ~0.4"
  const gap = 120000; // ~0.13" between images
  const perBox = Math.max(1, Math.floor((availH - titleH - gap * usable.length) / usable.length));

  // Ensure content types for jpg + png.
  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ct = await ctFile.async("string");
    if (!/<Default\b[^>]*Extension="jpe?g"/i.test(ct)) {
      ct = ct.replace(/<\/Types>/, '<Default Extension="jpg" ContentType="image/jpeg"/></Types>');
    }
    if (!/<Default\b[^>]*Extension="png"/i.test(ct)) {
      ct = ct.replace(/<\/Types>/, '<Default Extension="png" ContentType="image/png"/></Types>');
    }
    zip.file("[Content_Types].xml", ct);
  }

  // Ensure drawing namespaces.
  xml = xml.replace(/<w:document\b([^>]*)>/, (_m, attrs) => {
    let a = attrs as string;
    if (!/xmlns:r=/.test(a)) a += ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    if (!/xmlns:wp=/.test(a)) a += ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    return `<w:document${a}>`;
  });

  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  let rels = relsFile ? await relsFile.async("string") : "";
  let nextRel = (() => {
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => parseInt(m[1], 10));
    return (ids.length ? Math.max(...ids) : 0) + 1;
  })();

  let body = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  if (opts.pageTitle) {
    body += `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">${opts.pageTitle.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`;
  }

  let idx = 0;
  for (const im of usable) {
    idx++;
    const raw = im.base64.replace(/^data:[^,]+,/, "");
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length === 0) continue;
    const isPng = /png/i.test(im.mimeType || "") || raw.startsWith("iVBOR");
    const ext = isPng ? "png" : "jpg";
    const imgName = `aadhaar-card-${idx}.${ext}`;
    zip.file(`word/media/${imgName}`, bytes);
    const rId = "rId" + nextRel++;
    rels = rels.replace(
      /<\/Relationships>/,
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${imgName}"/></Relationships>`
    );

    // Fit within (availW, perBox), preserving aspect ratio. We don't know the
    // pixel dimensions here, so assume a typical Aadhaar card ratio (~1.58:1)
    // unless the box constrains width first.
    const assumedRatio = 1.58; // width / height
    let cx = availW;
    let cy = Math.round(cx / assumedRatio);
    if (cy > perBox) { cy = perBox; cx = Math.round(cy * assumedRatio); }
    if (cx > availW) { cx = availW; cy = Math.round(cx / assumedRatio); }
    const drawingId = 525000 + idx;
    body +=
      `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:r><w:drawing>` +
      `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${drawingId}" name="${imgName}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${imgName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline>` +
      `</w:drawing></w:r></w:p>`;
  }

  if (relsFile) zip.file(relsPath, rels);

  const bodyClose = xml.lastIndexOf("</w:body>");
  const lastSect = xml.lastIndexOf("<w:sectPr");
  const lastParaClose = xml.lastIndexOf("</w:p>");
  let insertAt: number;
  if (lastSect !== -1 && lastSect < bodyClose && lastSect > lastParaClose) {
    insertAt = lastSect;
  } else {
    insertAt = bodyClose === -1 ? xml.length : bodyClose;
  }
  xml = xml.slice(0, insertAt) + body + xml.slice(insertAt);
  zip.file("word/document.xml", xml);
  stripZipDirectoryEntries(zip);

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

// -----------------------------------------------------------------------------
// VERIFY FLOW — build the discrepancy report as a Word (.docx) with a 5-column
// table (Category · Issue · In Document · Should Be · Severity). Each header and
// each cell is bilingual (English + Telugu) to mirror the on-screen table. This
// is a self-contained builder used only by the verify flow's report download; it
// does NOT touch the deed-generation builders above.
// -----------------------------------------------------------------------------
export interface ReportDiscrepancy {
  category?: string;
  categoryTe?: string;
  description?: string;
  descriptionTe?: string;
  found?: string;
  expected?: string;
  severity?: string;
}
export interface VerificationReportMeta {
  documentName?: string;
  registrationDate?: string;
  statusMessage?: string;
}

const REPORT_FONT = "Nirmala UI"; // ships with Windows; renders Latin + Telugu.
const HEADER_FILL = "0A4D4A";
const CRITICAL_FILL = "FDECEC";
const WARNING_FILL = "FFF6E5";

// The discrepancy text is AI-generated and may contain characters that are
// ILLEGAL in XML 1.0 (control chars 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, and lone
// surrogates). The docx library escapes &/<>/ but does NOT strip these, so they
// end up in word/document.xml verbatim and Word refuses to open the file
// ("Unspecified error ... Location: Part: /word/document.xml"). Strip them, and
// collapse newlines/tabs to spaces since a single TextRun cannot represent them.
function sanitizeReportText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[\t\r\n]+/g, " ") // collapse whitespace a single TextRun cannot hold
    // XML 1.0 illegal control chars: 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F plus 0xFFFE/0xFFFF
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "") // lone high surrogate
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1") // lone low surrogate
    .trim();
}

function reportCell(
  lines: { text: string; bold?: boolean; color?: string; size?: number }[],
  opts: { width: number; fill?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = { width: 20 }
): TableCell {
  return new TableCell({
    width: { size: opts.width, type: WidthType.PERCENTAGE },
    shading: opts.fill ? { type: ShadingType.CLEAR, color: "auto", fill: opts.fill } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: lines.map(
      (ln) =>
        new Paragraph({
          alignment: opts.align ?? AlignmentType.LEFT,
          spacing: { after: 20, line: 264 },
          children: [
            new TextRun({
              text: sanitizeReportText(ln.text) || "—",
              bold: ln.bold,
              color: ln.color,
              size: ln.size ?? 18, // half-points → 9pt
              font: REPORT_FONT,
            }),
          ],
        })
    ),
  });
}

export async function buildVerificationReportDocx(
  discrepancies: ReportDiscrepancy[],
  meta: VerificationReportMeta = {}
): Promise<Buffer> {
  const COLS = [26, 30, 18, 18, 8]; // Category, Issue, In Document, Should Be, Severity
  const headerLabels = [
    ["Category", "వర్గం"],
    ["Issue", "సమస్య"],
    ["In Document", "పత్రంలో ఉన్నది"],
    ["Should Be", "ఉండవలసినది"],
    ["Severity", "తీవ్రత"],
  ];

  const headerRow = new TableRow({
    tableHeader: true,
    children: headerLabels.map((lbl, i) =>
      reportCell(
        [
          { text: lbl[0], bold: true, color: "FFFFFF", size: 19 },
          { text: lbl[1], bold: true, color: "D7EDEA", size: 17 },
        ],
        { width: COLS[i], fill: HEADER_FILL }
      )
    ),
  });

  const bodyRows = (discrepancies || []).map((d) => {
    const isCritical = String(d.severity || "").toUpperCase() === "CRITICAL";
    const fill = isCritical ? CRITICAL_FILL : WARNING_FILL;
    const sevColor = isCritical ? "B00020" : "8A5A00";
    const sevTe = isCritical ? "తీవ్రమైనది" : "హెచ్చరిక";
    return new TableRow({
      children: [
        reportCell(
          [
            { text: d.category || "", bold: true },
            ...(d.categoryTe ? [{ text: d.categoryTe, color: "0A4D4A", size: 16 }] : []),
          ],
          { width: COLS[0], fill }
        ),
        reportCell(
          [
            { text: d.description || "" },
            ...(d.descriptionTe ? [{ text: d.descriptionTe, color: "0A4D4A", size: 16 }] : []),
          ],
          { width: COLS[1], fill }
        ),
        reportCell([{ text: d.found || "", color: "B00020", bold: true }], { width: COLS[2], fill }),
        reportCell([{ text: d.expected || "", color: "0A6B33", bold: true }], { width: COLS[3], fill }),
        reportCell(
          [
            { text: (d.severity || "").toUpperCase(), bold: true, color: sevColor, size: 16 },
            { text: sevTe, color: sevColor, size: 15 },
          ],
          { width: COLS[4], fill, align: AlignmentType.CENTER }
        ),
      ],
    });
  });

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "C9D6D4" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "C9D6D4" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "C9D6D4" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "C9D6D4" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "C9D6D4" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "C9D6D4" },
    },
    rows: [headerRow, ...bodyRows],
  });

  const titleBlock: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: "DEED VERIFICATION REPORT", bold: true, size: 30, font: REPORT_FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: "దస్తావేజు పరిశీలన నివేదిక", bold: true, size: 22, color: "0A4D4A", font: REPORT_FONT }),
      ],
    }),
  ];

  const metaLines: Paragraph[] = [];
  if (meta.documentName)
    metaLines.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({ text: "Document / పత్రం: ", bold: true, size: 18, font: REPORT_FONT }),
          new TextRun({ text: sanitizeReportText(meta.documentName), size: 18, font: REPORT_FONT }),
        ],
      })
    );
  if (meta.registrationDate)
    metaLines.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({ text: "Registration Date / తేదీ: ", bold: true, size: 18, font: REPORT_FONT }),
          new TextRun({ text: sanitizeReportText(meta.registrationDate), size: 18, font: REPORT_FONT }),
        ],
      })
    );
  metaLines.push(
    new Paragraph({
      spacing: { after: 200 },
      children: [
        new TextRun({ text: "Discrepancies found / గుర్తించిన తేడాలు: ", bold: true, size: 18, font: REPORT_FONT }),
        new TextRun({ text: String((discrepancies || []).length), bold: true, size: 18, color: "B00020", font: REPORT_FONT }),
      ],
    })
  );

  const cleanBlock: Paragraph[] =
    (discrepancies || []).length === 0
      ? [
          new Paragraph({
            spacing: { before: 200 },
            children: [
              new TextRun({
                text: "No discrepancies detected — the document matches the entered details and uploaded documents.",
                bold: true,
                color: "0A6B33",
                size: 20,
                font: REPORT_FONT,
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "ఎటువంటి తేడాలు కనుగొనబడలేదు — పత్రం నమోదు వివరాలతో మరియు అప్‌లోడ్ చేసిన పత్రాలతో సరిపోలింది.",
                color: "0A6B33",
                size: 18,
                font: REPORT_FONT,
              }),
            ],
          }),
        ]
      : [];

  const doc = new Document({
    creator: "Telangana Sale Deed Wizard",
    title: "Deed Verification Report",
    styles: { default: { document: { run: { font: REPORT_FONT, size: 18 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
            margin: {
              top: convertInchesToTwip(0.8),
              right: convertInchesToTwip(0.6),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(0.6),
            },
          },
        },
        children: [
          ...titleBlock,
          ...metaLines,
          ...((discrepancies || []).length > 0 ? [table] : []),
          ...cleanBlock,
        ],
      },
    ],
  });

  return packDocxClean(doc);
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
