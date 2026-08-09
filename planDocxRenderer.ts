// planDocxRenderer.ts
// -----------------------------------------------------------------------------
// EDITABLE (native Word shapes) version of the "PLAN FOR REGISTRATION" one-pager.
//
// planRenderer.ts renders the plan as one flat SVG -> rasterised image, which is
// exact and reliable but NOT editable once it's in the .docx (Word just sees a
// picture). This module reuses the exact same surveying/geometry math (plot
// reconstruction, road bands, dimension/neighbour placement, printed-area
// reconciliation, prompt-driven edits) but emits real Word DrawingML shapes
// instead of SVG tags: a text box for every piece of text (title, description,
// party paragraphs, dimensions, neighbour names, road labels, signature labels),
// a freeform (custom-geometry) shape for the plot outline, plain rectangles for
// road bands and interior structures, and simple primitive shapes (ellipse +
// lines) for the north-arrow symbol.
//
// Every shape this module emits is independently selectable, movable, and (for
// text boxes) editable in Word — click a dimension and retype it, drag the plot
// outline's vertices, delete/redraw a line. That is the whole point of this
// module: it trades the image version's "always exactly right" guarantee for
// genuine post-export editability, which is why it ships as an ADDITIONAL
// export option rather than a replacement (see server.ts /api/export-document
// `editablePlan` flag).
//
// Coordinate strategy: we compute every shape's position in the SAME 800x1131
// SVG-pixel virtual canvas that renderRegistrationPlanSvg() uses (so the two
// renderers stay visually identical), then convert px -> EMU with a single
// scale-to-fit factor computed from the TARGET DOCUMENT's own usable page area
// (mirroring appendPlanPageToDocx's usablePageEmu/scale-fit logic for the image
// version), so the editable canvas fills the page the same way the image does.
// -----------------------------------------------------------------------------

import {
  normDir,
  parseFeet,
  reconstructRectilinear,
  closeTraverse,
  reconcileSidesWithPrintedArea,
  personLine,
  buildPlanDescription,
  type PlanEdits,
  type ByDir,
  type Pt,
  type RoadEdit,
} from "./planRenderer";

// EMU per SVG pixel, matching planRenderer's virtual canvas being treated as a
// 96dpi bitmap elsewhere in this codebase (documentBuilder.ts's EMU_PER_PX).
const EMU_PER_PX = 9525;
const W = 800;
const H = 1131; // same virtual canvas size as renderRegistrationPlanSvg

// ---- XML helpers -------------------------------------------------------------

function escXml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let shapeIdCounter = 420000; // arbitrary base, distinct from appendPlanPageToDocx's 424242 pic id
let relHeightCounter = 1; // increasing z-order: later shapes paint on top

function nextShapeId(): number {
  return ++shapeIdCounter;
}
function nextRelHeight(): number {
  return relHeightCounter++;
}

interface Placement {
  /** SVG px, top-left of the shape's bounding box. */
  x: number;
  y: number;
  w: number;
  h: number;
}

// Wrap any wps:wsp shape body in the standard floating-anchor envelope, absolutely
// positioned on the page at (originX + x*scale, originY + y*scale) EMU. Every
// shape (rect/freeform/textbox/line/ellipse) goes through this one function so
// the px->EMU conversion and z-ordering live in exactly one place.
function anchorWrap(
  place: Placement,
  originXEmu: number,
  originYEmu: number,
  pxToEmu: number,
  bodyXml: string,
  opts: { behindDoc?: boolean; name: string }
): string {
  const id = nextShapeId();
  const relHeight = nextRelHeight();
  const offX = Math.round(originXEmu + place.x * pxToEmu);
  const offY = Math.round(originYEmu + place.y * pxToEmu);
  const cx = Math.max(1, Math.round(place.w * pxToEmu));
  const cy = Math.max(1, Math.round(place.h * pxToEmu));
  return (
    `<w:r><w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${relHeight}" ` +
    `behindDoc="${opts.behindDoc ? "1" : "0"}" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${offX}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${offY}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="${escXml(opts.name)}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
    bodyXml +
    `</a:graphicData></a:graphic>` +
    `</wp:anchor></w:drawing></w:r>`
  );
}

const WPS_NS = `xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"`;

// A rectangle shape (used for road bands, interior structure boxes, the "AREA
// UNDER REGN" checkbox, and the plot bounding fallback). fill="none" draws an
// outline-only box (checkbox); a hex fill draws a solid rect.
function rectShape(
  place: Placement,
  originXEmu: number,
  originYEmu: number,
  pxToEmu: number,
  opts: { fill?: string | "none"; strokeColor?: string; strokeWidthPx?: number; name: string }
): string {
  const cx = Math.max(1, Math.round(place.w * pxToEmu));
  const cy = Math.max(1, Math.round(place.h * pxToEmu));
  const fillXml =
    !opts.fill || opts.fill === "none"
      ? `<a:noFill/>`
      : `<a:solidFill><a:srgbClr val="${(opts.fill || "#ffffff").replace("#", "")}"/></a:solidFill>`;
  const strokeW = Math.max(1, Math.round((opts.strokeWidthPx ?? 1) * EMU_PER_PX));
  const strokeColor = (opts.strokeColor || "#000000").replace("#", "");
  const body =
    `<wps:wsp ${WPS_NS}>` +
    `<wps:cNvSpPr/>` +
    `<wps:spPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    fillXml +
    `<a:ln w="${strokeW}"><a:solidFill><a:srgbClr val="${strokeColor}"/></a:solidFill></a:ln>` +
    `</wps:spPr>` +
    `<wps:bodyPr/>` +
    `</wps:wsp>`;
  return anchorWrap(place, originXEmu, originYEmu, pxToEmu, body, { name: opts.name });
}

// An ellipse (used for the north-arrow compass circle).
function ellipseShape(
  place: Placement,
  originXEmu: number,
  originYEmu: number,
  pxToEmu: number,
  opts: { fill?: string; strokeColor?: string; strokeWidthPx?: number; name: string }
): string {
  const cx = Math.max(1, Math.round(place.w * pxToEmu));
  const cy = Math.max(1, Math.round(place.h * pxToEmu));
  const fillXml = `<a:solidFill><a:srgbClr val="${(opts.fill || "#ffffff").replace("#", "")}"/></a:solidFill>`;
  const strokeW = Math.max(1, Math.round((opts.strokeWidthPx ?? 1.2) * EMU_PER_PX));
  const strokeColor = (opts.strokeColor || "#000000").replace("#", "");
  const body =
    `<wps:wsp ${WPS_NS}>` +
    `<wps:cNvSpPr/>` +
    `<wps:spPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>` +
    fillXml +
    `<a:ln w="${strokeW}"><a:solidFill><a:srgbClr val="${strokeColor}"/></a:solidFill></a:ln>` +
    `</wps:spPr>` +
    `<wps:bodyPr/>` +
    `</wps:wsp>`;
  return anchorWrap(place, originXEmu, originYEmu, pxToEmu, body, { name: opts.name });
}

// A straight line/connector between two SVG-px points, drawn as a "line" preset
// geometry shape sized to its own bounding box with flipH/flipV chosen so the
// diagonal actually runs from `a` to `b` (the preset always draws its LOCAL
// (0,0)->(w,h) diagonal; flips mirror that within the same bounding box).
function lineShape(
  a: Pt2,
  b: Pt2,
  originXEmu: number,
  originYEmu: number,
  pxToEmu: number,
  opts: { strokeColor?: string; strokeWidthPx?: number; name: string; dashed?: boolean }
): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const w = Math.max(0.5, Math.abs(dx));
  const h = Math.max(0.5, Math.abs(dy));
  const flipH = dx < 0;
  const flipV = dy < 0;
  const cx = Math.max(1, Math.round(w * pxToEmu));
  const cy = Math.max(1, Math.round(h * pxToEmu));
  const offX = Math.round(originXEmu + x0 * pxToEmu);
  const offY = Math.round(originYEmu + y0 * pxToEmu);
  const strokeW = Math.max(1, Math.round((opts.strokeWidthPx ?? 1.4) * EMU_PER_PX));
  const strokeColor = (opts.strokeColor || "#000000").replace("#", "");
  const id = nextShapeId();
  const relHeight = nextRelHeight();
  const dashXml = opts.dashed ? `<a:prstDash val="dash"/>` : "";
  const flipAttrs = `${flipH ? ' flipH="1"' : ""}${flipV ? ' flipV="1"' : ""}`;
  const body =
    `<wps:wsp ${WPS_NS}>` +
    `<wps:cNvSpPr/>` +
    `<wps:spPr>` +
    `<a:xfrm${flipAttrs}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
    `<a:noFill/>` +
    `<a:ln w="${strokeW}"><a:solidFill><a:srgbClr val="${strokeColor}"/></a:solidFill>${dashXml}</a:ln>` +
    `</wps:spPr>` +
    `<wps:bodyPr/>` +
    `</wps:wsp>`;
  return (
    `<w:r><w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${relHeight}" ` +
    `behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${offX}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${offY}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="${escXml(opts.name)}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
    body +
    `</a:graphicData></a:graphic>` +
    `</wp:anchor></w:drawing></w:r>`
  );
}

interface Pt2 {
  x: number;
  y: number;
}

// A closed freeform polygon (the plot outline) built as custom geometry so Word
// treats it as ONE shape whose vertices can be dragged ("Edit Points"), rather
// than N separate unconnected line segments.
function freeformPolygon(
  pointsPx: Pt2[],
  originXEmu: number,
  originYEmu: number,
  pxToEmu: number,
  opts: { fill?: string; strokeColor?: string; strokeWidthPx?: number; name: string }
): string {
  const xs = pointsPx.map((p) => p.x);
  const ys = pointsPx.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - minX);
  const h = Math.max(1, Math.max(...ys) - minY);
  const cx = Math.max(1, Math.round(w * pxToEmu));
  const cy = Math.max(1, Math.round(h * pxToEmu));
  // custGeom path coordinates are in the shape's OWN local units; using px
  // directly (scaled by pxToEmu into the same units as cx/cy) keeps the path
  // proportional to the ext we declare.
  const local = pointsPx.map((p) => ({
    x: Math.round((p.x - minX) * pxToEmu),
    y: Math.round((p.y - minY) * pxToEmu),
  }));
  const lineTos = local
    .slice(1)
    .map((p) => `<a:lnTo><a:pt x="${p.x}" y="${p.y}"/></a:lnTo>`)
    .join("");
  const fillXml = opts.fill
    ? `<a:solidFill><a:srgbClr val="${opts.fill.replace("#", "")}"/></a:solidFill>`
    : `<a:noFill/>`;
  const strokeW = Math.max(1, Math.round((opts.strokeWidthPx ?? 2.4) * EMU_PER_PX));
  const strokeColor = (opts.strokeColor || "#000000").replace("#", "");
  const body =
    `<wps:wsp ${WPS_NS}>` +
    `<wps:cNvSpPr/>` +
    `<wps:spPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:custGeom>` +
    `<a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>` +
    `<a:rect l="0" t="0" r="${cx}" b="${cy}"/>` +
    `<a:pathLst><a:path w="${cx}" h="${cy}">` +
    `<a:moveTo><a:pt x="${local[0].x}" y="${local[0].y}"/></a:moveTo>` +
    lineTos +
    `<a:close/>` +
    `</a:path></a:pathLst>` +
    `</a:custGeom>` +
    fillXml +
    `<a:ln w="${strokeW}"><a:solidFill><a:srgbClr val="${strokeColor}"/></a:solidFill><a:round/></a:ln>` +
    `</wps:spPr>` +
    `<wps:bodyPr/>` +
    `</wps:wsp>`;
  return anchorWrap({ x: minX, y: minY, w, h }, originXEmu, originYEmu, pxToEmu, body, { name: opts.name });
}

// A real, editable Word text box: click it, click again to enter it, retype the
// text. `rotationDeg` rotates the WHOLE box (used for the vertical E/W dimension
// and neighbour labels, and the north-arrow's "N" glyph).
function textBox(
  place: Placement,
  originXEmu: number,
  originYEmu: number,
  pxToEmu: number,
  opts: {
    text: string;
    fontSizePt: number;
    bold?: boolean;
    underline?: boolean;
    italic?: boolean;
    align?: "left" | "center" | "right";
    rotationDeg?: number;
    name: string;
  }
): string {
  const cx = Math.max(1, Math.round(place.w * pxToEmu));
  const cy = Math.max(1, Math.round(place.h * pxToEmu));
  const halfPt = Math.round(opts.fontSizePt * 2);
  const align = opts.align === "center" ? "center" : opts.align === "right" ? "right" : "left";
  const rPr =
    `<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>` +
    `${opts.bold ? "<w:b/>" : ""}${opts.italic ? "<w:i/>" : ""}${opts.underline ? '<w:u w:val="single"/>' : ""}` +
    `<w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/></w:rPr>`;
  const text = escXml(opts.text);
  const para =
    `<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>` +
    `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  // rot is in 60,000ths of a degree, CLOCKWISE, on the a:xfrm of the shape itself.
  const rotAttr = opts.rotationDeg ? ` rot="${Math.round(opts.rotationDeg * 60000)}"` : "";
  const body =
    `<wps:wsp ${WPS_NS}>` +
    `<wps:cNvSpPr txBox="1"/>` +
    `<wps:spPr>` +
    `<a:xfrm${rotAttr}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:noFill/><a:ln><a:noFill/></a:ln>` +
    `</wps:spPr>` +
    `<wps:txbx><w:txbxContent>${para}</w:txbxContent></wps:txbx>` +
    `<wps:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:noAutofit/></wps:bodyPr>` +
    `</wps:wsp>`;
  return anchorWrap(place, originXEmu, originYEmu, pxToEmu, body, { name: opts.name });
}

// ---- greedy word-wrap (px-metric estimate — mirrors planRenderer's wrap()) ---
function wrapLines(text: string, maxWidthPx: number, fontSizePx: number, boldish = false): string[] {
  const charW = fontSizePx * (boldish ? 0.64 : 0.6);
  const maxChars = Math.max(6, Math.floor(maxWidthPx / charW));
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? cur + " " + w : w;
    if (cand.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cand;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// A multi-line text box: ONE shape containing several paragraphs, so wrapped
// body text (description, party blocks) behaves as a single editable paragraph
// in Word rather than N independent single-line boxes.
function multilineTextBox(
  place: Placement,
  originXEmu: number,
  originYEmu: number,
  pxToEmu: number,
  opts: { lines: Array<{ text: string; bold?: boolean; underline?: boolean }>; fontSizePt: number; name: string }
): string {
  const cx = Math.max(1, Math.round(place.w * pxToEmu));
  const cy = Math.max(1, Math.round(place.h * pxToEmu));
  const halfPt = Math.round(opts.fontSizePt * 2);
  const paras = opts.lines
    .map((ln) => {
      const rPr =
        `<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>` +
        `${ln.bold ? "<w:b/>" : ""}${ln.underline ? '<w:u w:val="single"/>' : ""}` +
        `<w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/></w:rPr>`;
      return (
        `<w:p><w:pPr><w:spacing w:before="0" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr>` +
        `<w:r>${rPr}<w:t xml:space="preserve">${escXml(ln.text)}</w:t></w:r></w:p>`
      );
    })
    .join("");
  const body =
    `<wps:wsp ${WPS_NS}>` +
    `<wps:cNvSpPr txBox="1"/>` +
    `<wps:spPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:noFill/><a:ln><a:noFill/></a:ln>` +
    `</wps:spPr>` +
    `<wps:txbx><w:txbxContent>${paras}</w:txbxContent></wps:txbx>` +
    `<wps:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:noAutofit/></wps:bodyPr>` +
    `</wps:wsp>`;
  return anchorWrap(place, originXEmu, originYEmu, pxToEmu, body, { name: opts.name });
}

// ---- main entry point --------------------------------------------------------

export interface EditablePlanInput {
  plan?: any | null;
  details?: any | null;
  edits?: PlanEdits | null;
  /** Usable width/height (EMU) of the target document's content area — the
   *  editable canvas is scaled to fit inside this, same as the image version. */
  availWEmu: number;
  availHEmu: number;
}

// Builds the full set of <w:r><w:drawing>...</w:drawing></w:r> blocks for the
// editable plan page. Returns them pre-joined, ready to sit inside a single
// <w:p> paragraph (the caller wraps this in a page-break + paragraph and splices
// it into the target .docx — see documentBuilder.ts's
// appendEditablePlanPageToDocx, which mirrors appendPlanPageToDocx's approach).
export function buildEditablePlanDrawingXml(input: EditablePlanInput): string {
  shapeIdCounter = 420000;
  relHeightCounter = 1;

  const plan = input.plan || {};
  const d = input.details || {};
  const prop = d.property || {};
  const drawing = plan.drawing || {};
  const edits = input.edits || {};

  if (edits.boundaries && Object.keys(edits.boundaries).length) {
    const b = { ...(prop.boundaries || {}) };
    if (edits.boundaries.N) b.north = edits.boundaries.N;
    if (edits.boundaries.S) b.south = edits.boundaries.S;
    if (edits.boundaries.E) b.east = edits.boundaries.E;
    if (edits.boundaries.W) b.west = edits.boundaries.W;
    prop.boundaries = b;
  }

  // Scale-to-fit the 800x1131 virtual canvas into the target page's usable area
  // (identical reasoning to appendPlanPageToDocx's natW/natH/scale for the image).
  const natWEmu = W * EMU_PER_PX;
  const natHEmu = H * EMU_PER_PX;
  const fitScale = Math.min(input.availWEmu / natWEmu, input.availHEmu / natHEmu, 1);
  const pxToEmu = EMU_PER_PX * fitScale;
  // Centre the (scaled) canvas within the available area.
  const originXEmu = Math.max(0, (input.availWEmu - W * pxToEmu) / 2);
  const originYEmu = Math.max(0, (input.availHEmu - H * pxToEmu) / 2);

  const out: string[] = [];
  const M = 22;
  const contentX = M + 14;
  const contentW = W - 2 * (M + 14);

  // ---- Outer border (two rects mirroring the SVG's double frame) ----
  out.push(
    rectShape({ x: M, y: M, w: W - 2 * M, h: H - 2 * M }, originXEmu, originYEmu, pxToEmu, {
      fill: "none",
      strokeColor: "#000000",
      strokeWidthPx: 2,
      name: "PlanOuterBorder",
    })
  );
  out.push(
    rectShape({ x: M + 5, y: M + 5, w: W - 2 * M - 10, h: H - 2 * M - 10 }, originXEmu, originYEmu, pxToEmu, {
      fill: "none",
      strokeColor: "#000000",
      strokeWidthPx: 0.8,
      name: "PlanInnerBorder",
    })
  );

  let y = M + 46;

  // ---- Title ----
  const title = (edits.title || plan.title || "PLAN FOR REGISTRATION").toUpperCase();
  out.push(
    textBox({ x: M, y: y - 22, w: W - 2 * M, h: 34 }, originXEmu, originYEmu, pxToEmu, {
      text: title,
      fontSizePt: 20,
      bold: true,
      align: "center",
      name: "PlanTitle",
    })
  );
  const titleW = title.length * 27 * 0.6;
  out.push(
    lineShape(
      { x: W / 2 - titleW / 2, y: y + 5 },
      { x: W / 2 + titleW / 2, y: y + 5 },
      originXEmu,
      originYEmu,
      pxToEmu,
      { strokeColor: "#000000", strokeWidthPx: 1.2, name: "PlanTitleUnderline" }
    )
  );
  y += 30;

  // ---- Property description (ONE multi-line editable text box) ----
  const desc = (plan.propertyDescription && plan.propertyDescription.trim()) || buildPlanDescription(plan, prop);
  const descLines = wrapLines(desc, contentW, 16);
  const descH = descLines.length * 21 + 8;
  out.push(
    multilineTextBox({ x: contentX, y: y - 16, w: contentW, h: descH }, originXEmu, originYEmu, pxToEmu, {
      lines: descLines.map((ln) => ({ text: ln })),
      fontSizePt: 12,
      name: "PlanDescription",
    })
  );
  y += descLines.length * 21 + 10;

  // ---- Party paragraphs (EXECUTANT/S, CLAIMANT/S — same fixed labels the SVG
  // version uses for the plan, regardless of transaction type) ----
  const roles = { first: "EXECUTANT/S", second: "CLAIMANT/S" };
  const sellers: any[] = Array.isArray(d.executants) ? d.executants : [];
  const buyers: any[] = Array.isArray(d.claimants) ? d.claimants : [];
  const firstList = sellers.map(personLine).filter(Boolean);
  if (!firstList.length) {
    const fb = (plan.parties || []).find((p: any) => /vendor|donor|mortgagor|lessor|first|releasor|settlor/i.test(p.role))?.detail;
    if (fb) firstList.push(fb);
  }
  const secondList = buyers.map(personLine).filter(Boolean);
  if (!secondList.length) {
    const fb = (plan.parties || []).find((p: any) => /vendee|donee|mortgagee|lessee|second|releasee|settlee/i.test(p.role))?.detail;
    if (fb) secondList.push(fb);
  }
  const emitParty = (label: string, people: string[]) => {
    const list = people.filter(Boolean);
    if (!list.length) return;
    const allLines: Array<{ text: string; bold?: boolean; underline?: boolean }> = [
      { text: `${label}:`, bold: true, underline: true },
    ];
    for (const person of list) {
      for (const ln of wrapLines(person, contentW, 16)) allLines.push({ text: ln });
    }
    const boxH = allLines.length * 21 + 8;
    out.push(
      multilineTextBox({ x: contentX, y: y - 16, w: contentW, h: boxH }, originXEmu, originYEmu, pxToEmu, {
        lines: allLines,
        fontSizePt: 12,
        name: `PlanParty_${label.replace(/[^A-Za-z]/g, "")}`,
      })
    );
    y += boxH + 8;
  };
  emitParty(roles.first, firstList);
  emitParty(roles.second, secondList);

  // ================= DRAWING REGION =================
  const rowTop = Math.max(y + 18, 300);
  const RX = contentX + 6;
  const RY = rowTop + 10;
  const RW = contentW - 12;
  const BOTTOM_BLOCK_H = 188;
  const RH = Math.max(460, H - M - 5 - RY - BOTTOM_BLOCK_H);
  const regL = RX + 4, regR = RX + RW - 4, regT = RY + 4, regB = RY + RH - 4;

  // ---- Gather measurements (identical logic to renderRegistrationPlanSvg) ----
  const rawSides: any[] = Array.isArray(drawing?.plot?.sides) ? drawing.plot.sides : [];
  const byDir: ByDir = {};
  for (const s of rawSides) {
    const dir = normDir(s?.direction);
    if (!dir) continue;
    const len = isFinite(s?.lengthFeet) && s.lengthFeet > 0 ? s.lengthFeet : parseFeet(s?.lengthLabel);
    if (!(len && len > 0)) {
      if (!byDir[dir]) byDir[dir] = { lengthFeet: 0, label: String(s?.lengthLabel || ""), neighbour: String(s?.neighbour || "") };
      continue;
    }
    if (!byDir[dir] || !(byDir[dir]!.lengthFeet > 0)) {
      byDir[dir] = { lengthFeet: len, label: String(s?.lengthLabel || `${Math.round(len)}'`), neighbour: String(s?.neighbour || "") };
    }
  }
  reconcileSidesWithPrintedArea(byDir, plan.table);

  if (edits.dimensionRemap?.length) {
    for (const side of Object.values(byDir)) {
      if (!side) continue;
      for (const { from, to } of edits.dimensionRemap) {
        if (Math.abs(side.lengthFeet - from) < 0.5) {
          side.lengthFeet = to;
          side.label = `${Math.round(to)}'`;
          break;
        }
      }
    }
  }

  const formBounds = prop.boundaries || {};
  (["N", "S", "E", "W"] as const).forEach((k) => {
    const fb = k === "N" ? formBounds.north : k === "S" ? formBounds.south : k === "E" ? formBounds.east : formBounds.west;
    if (byDir[k] && !byDir[k]!.neighbour && fb) {
      byDir[k]!.neighbour = String(fb);
      byDir[k]!.fromForm = true;
    }
  });

  if (edits.boundaries) {
    (["N", "S", "E", "W"] as const).forEach((k) => {
      const ov = (edits.boundaries as any)?.[k];
      if (!ov) return;
      if (!byDir[k]) byDir[k] = { lengthFeet: 0, label: "", neighbour: "" };
      byDir[k]!.neighbour = ov;
      byDir[k]!.fromForm = false;
    });
  }

  const bearingLegs = rawSides
    .map((s) => ({ lengthFeet: isFinite(s?.lengthFeet) ? s.lengthFeet : parseFeet(s?.lengthLabel) || 0, bearingDeg: Number(s?.bearingDeg) || 0 }))
    .filter((l) => l.lengthFeet > 0);
  const hasBearings = rawSides.some((s) => Number(s?.bearingDeg) > 0) && bearingLegs.length >= 3;

  let cornersFeet: Pt[] | null = null;
  if (hasBearings) cornersFeet = closeTraverse(bearingLegs);
  if (!cornersFeet) {
    const rect = reconstructRectilinear(byDir);
    cornersFeet = rect ? rect.corners : null;
  }

  if (cornersFeet && cornersFeet.length >= 3) {
    const roadsRaw: any[] = Array.isArray(drawing?.roads) ? drawing.roads : [];
    const roadBySide = new Map<"N" | "S" | "E" | "W", { label: string; widthFeet: number }>();
    for (const rd of roadsRaw) {
      const side = normDir(rd?.side);
      if (!side) continue;
      const wf = isFinite(rd?.widthFeet) && rd.widthFeet > 0 ? rd.widthFeet : parseFeet(rd?.label) || 0;
      if (!roadBySide.has(side)) roadBySide.set(side, { label: String(rd?.label || ""), widthFeet: wf });
    }
    if (edits.roads) {
      (["N", "S", "E", "W"] as const).forEach((k) => {
        const ov = (edits.roads as any)?.[k] as RoadEdit | undefined;
        if (ov) roadBySide.set(k, { label: ov.label, widthFeet: ov.widthFeet || 0 });
      });
    }
    if (edits.dimensionRemap?.length) {
      for (const [side, info] of roadBySide) {
        for (const { from, to } of edits.dimensionRemap) {
          if (Math.abs(info.widthFeet - from) < 0.5) {
            roadBySide.set(side, { label: `${Math.round(to)}' ROAD`, widthFeet: to });
            break;
          }
        }
      }
    }

    const pxs = cornersFeet.map((p) => p.x);
    const pys = cornersFeet.map((p) => p.y);
    const pxMin = Math.min(...pxs), pxMax = Math.max(...pxs);
    const pyMin = Math.min(...pys), pyMax = Math.max(...pys);
    const plotWFeet = Math.max(1, pxMax - pxMin);
    const plotHFeet = Math.max(1, pyMax - pyMin);

    const LABELPAD = 16;
    const innerW = Math.max(1, RW - 2 * LABELPAD);
    const innerH = Math.max(1, RH - 2 * LABELPAD);
    const sc = Math.min((innerW * 0.56) / plotWFeet, (innerH * 0.56) / plotHFeet);

    const plotWpx = plotWFeet * sc;
    const plotHpx = plotHFeet * sc;
    const cx = RX + RW / 2;
    const cy = RY + RH / 2;
    const mpx = (fx: number) => cx + (fx - (pxMin + pxMax) / 2) * sc;
    const mpy = (fy: number) => cy - (fy - (pyMin + pyMax) / 2) * sc;

    const plotL = cx - plotWpx / 2;
    const plotR = cx + plotWpx / 2;
    const plotT = cy - plotHpx / 2;
    const plotB = cy + plotHpx / 2;
    const plotMinPx = Math.min(plotWpx, plotHpx);

    const roadPxRaw = new Map<string, number>();
    let maxRoadPx = 0;
    for (const [side, info] of roadBySide) {
      const pxw = info.widthFeet > 0 ? info.widthFeet * sc : 12;
      roadPxRaw.set(side, pxw);
      if (pxw > maxRoadPx) maxRoadPx = pxw;
    }
    const roadCap = 0.5 * plotMinPx;
    const roadShrink = maxRoadPx > roadCap && maxRoadPx > 0 ? roadCap / maxRoadPx : 1;
    const roadGap = 6;

    const roadRects: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const [side, info] of roadBySide) {
      const band = Math.max(6, (roadPxRaw.get(side) || 12) * roadShrink);
      let rx = 0, ry = 0, rw = 0, rh = 0;
      if (side === "N") { rx = plotL; rw = plotWpx; rh = band; ry = plotT - roadGap - band; }
      else if (side === "S") { rx = plotL; rw = plotWpx; rh = band; ry = plotB + roadGap; }
      else if (side === "W") { ry = plotT; rh = plotHpx; rw = band; rx = plotL - roadGap - band; }
      else { ry = plotT; rh = plotHpx; rw = band; rx = plotR + roadGap; }
      if (rx < regL) { rw -= regL - rx; rx = regL; }
      if (ry < regT) { rh -= regT - ry; ry = regT; }
      if (rx + rw > regR) rw = regR - rx;
      if (ry + rh > regB) rh = regB - ry;
      if (rw > 2 && rh > 2) {
        out.push(
          rectShape({ x: rx, y: ry, w: rw, h: rh }, originXEmu, originYEmu, pxToEmu, {
            fill: "#e2e2e2",
            strokeColor: "#000000",
            strokeWidthPx: 0.8,
            name: `RoadBand_${side}`,
          })
        );
        roadRects[side] = { x: rx, y: ry, w: rw, h: rh };
        const label = info.label || (info.widthFeet > 0 ? `${Math.round(info.widthFeet)}' ROAD` : "ROAD");
        const isVert = side === "E" || side === "W";
        const boxW = isVert ? rh : rw;
        const boxH = isVert ? rw : rh;
        const tcx = rx + rw / 2, tcy = ry + rh / 2;
        out.push(
          textBox({ x: tcx - boxW / 2, y: tcy - boxH / 2, w: boxW, h: boxH }, originXEmu, originYEmu, pxToEmu, {
            text: label,
            fontSizePt: 8.5,
            align: "center",
            rotationDeg: isVert ? 270 : 0,
            name: `RoadLabel_${side}`,
          })
        );
      }
    }

    // Plot polygon: ONE editable freeform shape.
    const ptsPx = cornersFeet.map((p) => ({ x: mpx(p.x), y: mpy(p.y) }));
    out.push(
      freeformPolygon(ptsPx, originXEmu, originYEmu, pxToEmu, {
        fill: "#ffffff",
        strokeColor: "#000000",
        strokeWidthPx: 2.6,
        name: "PlotOutline",
      })
    );

    // Interior structures.
    const interiors: any[] = Array.isArray(drawing?.interiorStructures) ? drawing.interiorStructures : [];
    const colorForLabel = (label: string): string => {
      const sc2 = edits.structureColors;
      if (!sc2) return "#ffffff";
      const norm = label.toLowerCase();
      for (const key of Object.keys(sc2)) {
        const kw = key === "rcc" ? /r\.?c\.?c\.?/i : new RegExp(key, "i");
        if (kw.test(norm)) return sc2[key];
      }
      return "#ffffff";
    };
    for (const st of interiors) {
      const label = String(st?.label || "").trim();
      if (!label) continue;
      const open = /open|vacant|khali|ఖాళీ/i.test(label);
      const wF = isFinite(st?.widthFeet) && st.widthFeet > 0 ? st.widthFeet : 0;
      const dF = isFinite(st?.depthFeet) && st.depthFeet > 0 ? st.depthFeet : 0;
      const pos = String(st?.position || "center").toLowerCase();
      const fill = colorForLabel(label);
      let ax = cx, ay = cy;
      const insetX = plotWpx * 0.26, insetY = plotHpx * 0.26;
      if (pos.includes("north")) ay = plotT + insetY;
      if (pos.includes("south")) ay = plotB - insetY;
      if (pos.includes("east")) ax = plotR - insetX;
      if (pos.includes("west")) ax = plotL + insetX;
      if (wF > 0 && dF > 0) {
        const bw = Math.min(plotWpx * 0.92, wF * sc);
        const bh = Math.min(plotHpx * 0.92, dF * sc);
        const bx = Math.max(plotL + 2, Math.min(plotR - bw - 2, ax - bw / 2));
        const by = Math.max(plotT + 2, Math.min(plotB - bh - 2, ay - bh / 2));
        if (!open) {
          out.push(
            rectShape({ x: bx, y: by, w: bw, h: bh }, originXEmu, originYEmu, pxToEmu, {
              fill,
              strokeColor: "#000000",
              strokeWidthPx: 1.4,
              name: `Interior_${label.replace(/\W+/g, "")}`,
            })
          );
        }
        out.push(
          textBox({ x: bx, y: by, w: bw, h: bh }, originXEmu, originYEmu, pxToEmu, {
            text: label,
            fontSizePt: Math.max(7, Math.min(10, (bw - 6) / Math.max(1, label.length * 0.6) / 1.3)),
            align: "center",
            name: `InteriorLabel_${label.replace(/\W+/g, "")}`,
          })
        );
      } else {
        out.push(
          textBox({ x: ax - 40, y: ay - 10, w: 80, h: 20 }, originXEmu, originYEmu, pxToEmu, {
            text: label,
            fontSizePt: 9,
            align: "center",
            name: `InteriorLabel_${label.replace(/\W+/g, "")}`,
          })
        );
      }
    }

    // Dimension + neighbour labels, one small text box each (fully editable).
    const edgeMid = (a: Pt, b: Pt) => ({ x: (mpx(a.x) + mpx(b.x)) / 2, y: (mpy(a.y) + mpy(b.y)) / 2 });
    const drawEdge = (dir: "N" | "S" | "E" | "W", a: Pt, b: Pt) => {
      const info = byDir[dir];
      const mid = edgeMid(a, b);
      const road = roadRects[dir];
      const vert = dir === "E" || dir === "W";
      const dimIn = 15;
      let dimX = mid.x, dimY = mid.y;
      if (dir === "N") dimY = plotT + dimIn;
      else if (dir === "S") dimY = plotB - dimIn + 4;
      else if (dir === "W") dimX = plotL + dimIn;
      else dimX = plotR - dimIn;
      const dimLabel = info?.label || (info && info.lengthFeet > 0 ? `${Math.round(info.lengthFeet)}'` : "");
      if (dimLabel) {
        const boxW = vert ? 24 : 70;
        const boxH = vert ? 70 : 18;
        out.push(
          textBox(
            { x: dimX - boxW / 2, y: dimY - boxH / 2, w: boxW, h: boxH },
            originXEmu,
            originYEmu,
            pxToEmu,
            { text: dimLabel, fontSizePt: 9, bold: true, align: "center", rotationDeg: vert ? 270 : 0, name: `Dim_${dir}` }
          )
        );
      }
      const neigh = info?.neighbour;
      const roadLike = /road|highway|street|lane|రోడ్/i.test(neigh || "");
      if (neigh && !(road && roadLike) && !(road && info?.fromForm)) {
        let nx = mid.x, ny = mid.y;
        const beyond = 22;
        if (dir === "N") ny = (road ? road.y : plotT) - beyond;
        else if (dir === "S") ny = (road ? road.y + road.h : plotB) + beyond;
        else if (dir === "W") nx = (road ? road.x : plotL) - beyond;
        else nx = (road ? road.x + road.w : plotR) + beyond;
        nx = Math.max(regL + 6, Math.min(regR - 6, nx));
        ny = Math.max(regT + 10, Math.min(regB - 6, ny));
        const boxW = vert ? 20 : 110;
        const boxH = vert ? 110 : 16;
        out.push(
          textBox(
            { x: nx - boxW / 2, y: ny - boxH / 2, w: boxW, h: boxH },
            originXEmu,
            originYEmu,
            pxToEmu,
            { text: neigh, fontSizePt: 8, align: "center", rotationDeg: vert ? 270 : 0, name: `Neighbour_${dir}` }
          )
        );
      }
    };
    if (cornersFeet.length === 4) {
      const [TL, TR, BR, BL] = cornersFeet;
      drawEdge("N", TL, TR);
      drawEdge("E", TR, BR);
      drawEdge("S", BR, BL);
      drawEdge("W", BL, TL);
    } else {
      for (let i = 0; i < cornersFeet.length; i++) {
        const a = cornersFeet[i];
        const b = cornersFeet[(i + 1) % cornersFeet.length];
        const mid = edgeMid(a, b);
        const leg = bearingLegs[i];
        if (leg) {
          out.push(
            textBox({ x: mid.x - 35, y: mid.y - 14, w: 70, h: 18 }, originXEmu, originYEmu, pxToEmu, {
              text: `${Math.round(leg.lengthFeet)}'`,
              fontSizePt: 9,
              align: "center",
              name: `Leg_${i}`,
            })
          );
        }
      }
    }

    // North arrow: ellipse + two lines (shaft + one arrowhead barb pair) + "N"
    // label. NOT grouped in this v1 (each primitive is independently selectable
    // and movable in Word) — rotationDeg still rotates the arrow's own line
    // primitives + the "N" text box together via each shape's own rotation, so
    // a prompt like "rotate north symbol 90 degrees" still visibly rotates the
    // whole symbol even though it is several shapes rather than one group.
    const rot = edits.northRotationDeg || 0;
    const nx0 = regR - 24, ny0 = regT + 30;
    out.push(
      ellipseShape({ x: nx0 - 18, y: ny0 - 18, w: 36, h: 36 }, originXEmu, originYEmu, pxToEmu, {
        fill: "#ffffff",
        strokeColor: "#000000",
        strokeWidthPx: 1.2,
        name: "NorthCircle",
      })
    );
    const rotatePt = (px: number, py: number): Pt2 => {
      if (!rot) return { x: px, y: py };
      const th = (rot * Math.PI) / 180;
      const dx = px - nx0, dy = py - ny0;
      return { x: nx0 + dx * Math.cos(th) - dy * Math.sin(th), y: ny0 + dx * Math.sin(th) + dy * Math.cos(th) };
    };
    const shaftTop = rotatePt(nx0, ny0 - 12);
    const shaftBottom = rotatePt(nx0, ny0 + 12);
    out.push(lineShape(shaftBottom, shaftTop, originXEmu, originYEmu, pxToEmu, { strokeColor: "#000000", strokeWidthPx: 1.6, name: "NorthShaft" }));
    const barbL = rotatePt(nx0 - 5, ny0 - 5);
    const barbR = rotatePt(nx0 + 5, ny0 - 5);
    out.push(lineShape(barbL, shaftTop, originXEmu, originYEmu, pxToEmu, { strokeColor: "#000000", strokeWidthPx: 1.6, name: "NorthBarbL" }));
    out.push(lineShape(barbR, shaftTop, originXEmu, originYEmu, pxToEmu, { strokeColor: "#000000", strokeWidthPx: 1.6, name: "NorthBarbR" }));
    const nLabelPt = rotatePt(nx0, ny0 - 15);
    out.push(
      textBox({ x: nLabelPt.x - 10, y: nLabelPt.y - 8, w: 20, h: 16 }, originXEmu, originYEmu, pxToEmu, {
        text: "N",
        fontSizePt: 8,
        bold: true,
        align: "center",
        name: "NorthLabel",
      })
    );
  } else {
    // ---- Fallback: no usable measurements — a plain rectangle from the form
    // boundaries. (Traced-polygon fallback is intentionally not ported to the
    // editable version: it is a rare degraded case, and its raw 0..1000-space
    // trace is far less meaningful as individually-editable shapes than as one
    // image; users hitting this path get the image plan, which already covers
    // it faithfully.) ----
    const bx = RX + 46, by = RY + 40, bw = RW - 92, bh = RH - 92;
    out.push(
      rectShape({ x: bx, y: by, w: bw, h: bh }, originXEmu, originYEmu, pxToEmu, {
        fill: "#ffffff",
        strokeColor: "#000000",
        strokeWidthPx: 2.6,
        name: "PlotFallbackRect",
      })
    );
    const b = formBounds;
    const edgeLabel = (text: string, x: number, y: number, w: number, h: number, rotationDeg: number, name: string) =>
      out.push(textBox({ x, y, w, h }, originXEmu, originYEmu, pxToEmu, { text, fontSizePt: 9, align: "center", rotationDeg, name }));
    if (b.north) edgeLabel(b.north, bx, by - 24, bw, 18, 0, "BoundaryN");
    if (b.south) edgeLabel(b.south, bx, by + bh + 6, bw, 18, 0, "BoundaryS");
    if (b.west) edgeLabel(b.west, bx - 60, by + bh / 2 - 9, 60, 18, 270, "BoundaryW");
    if (b.east) edgeLabel(b.east, bx + bw, by + bh / 2 - 9, 60, 18, 270, "BoundaryE");
    const nx0 = regR - 24, ny0 = regT + 30;
    out.push(ellipseShape({ x: nx0 - 18, y: ny0 - 18, w: 36, h: 36 }, originXEmu, originYEmu, pxToEmu, { fill: "#ffffff", strokeColor: "#000000", strokeWidthPx: 1.2, name: "NorthCircle" }));
    out.push(lineShape({ x: nx0, y: ny0 + 12 }, { x: nx0, y: ny0 - 12 }, originXEmu, originYEmu, pxToEmu, { strokeColor: "#000000", strokeWidthPx: 1.6, name: "NorthShaft" }));
    out.push(textBox({ x: nx0 - 10, y: ny0 - 23, w: 20, h: 16 }, originXEmu, originYEmu, pxToEmu, { text: "N", fontSizePt: 8, bold: true, align: "center", name: "NorthLabel" }));
  }

  // ================= BOTTOM BLOCK =================
  const bottomY = RY + RH + 46;
  const rightColX = contentX + contentW * 0.58;
  const chk = 16;
  out.push(
    rectShape({ x: contentX, y: bottomY - chk + 3, w: chk, h: chk }, originXEmu, originYEmu, pxToEmu, {
      fill: "none",
      strokeColor: "#000000",
      strokeWidthPx: 1.2,
      name: "AreaUnderRegnCheckbox",
    })
  );
  out.push(
    textBox({ x: contentX + chk + 6, y: bottomY - 14, w: 220, h: 20 }, originXEmu, originYEmu, pxToEmu, {
      text: "AREA UNDER REGN",
      fontSizePt: 10,
      bold: true,
      name: "AreaUnderRegnLabel",
    })
  );

  // Fixed labels regardless of transaction type — mirrors renderRegistrationPlanSvg,
  // which intentionally does NOT use partyRoleLabels() for the plan's own party/
  // signature blocks (see planRenderer.ts's comment above its `roles` constant).
  const sigLabels = { first: "EXECUTANT/S", second: "CLAIMANT/S" };
  const sigLine = (x: number, yy: number, label: string) => {
    const w2 = label.length * 13 * 0.62;
    out.push(
      textBox({ x, y: yy - 14, w: w2 + 10, h: 20 }, originXEmu, originYEmu, pxToEmu, {
        text: label,
        fontSizePt: 10,
        bold: true,
        name: `SigLabel_${label.replace(/\W+/g, "")}`,
      })
    );
    out.push(lineShape({ x, y: yy + 4 }, { x: x + w2, y: yy + 4 }, originXEmu, originYEmu, pxToEmu, { strokeColor: "#000000", strokeWidthPx: 0.8, name: `SigLine_${label.replace(/\W+/g, "")}` }));
  };
  sigLine(rightColX, bottomY, `${sigLabels.first} SIGN/S`);

  let sy = bottomY + 44;
  out.push(
    textBox({ x: contentX, y: sy - 14, w: 160, h: 20 }, originXEmu, originYEmu, pxToEmu, {
      text: "WITNESSESS.",
      fontSizePt: 10,
      bold: true,
      underline: true,
      name: "WitnessHeading",
    })
  );
  sy += 34;
  out.push(textBox({ x: contentX + 6, y: sy - 12, w: 20, h: 18 }, originXEmu, originYEmu, pxToEmu, { text: "1.", fontSizePt: 10, name: "Witness1Num" }));
  out.push(lineShape({ x: contentX + 24, y: sy + 2 }, { x: contentX + contentW * 0.42, y: sy + 2 }, originXEmu, originYEmu, pxToEmu, { strokeColor: "#000000", strokeWidthPx: 0.7, name: "Witness1Line" }));
  sy += 34;
  out.push(textBox({ x: contentX + 6, y: sy - 12, w: 20, h: 18 }, originXEmu, originYEmu, pxToEmu, { text: "2.", fontSizePt: 10, name: "Witness2Num" }));
  out.push(lineShape({ x: contentX + 24, y: sy + 2 }, { x: contentX + contentW * 0.42, y: sy + 2 }, originXEmu, originYEmu, pxToEmu, { strokeColor: "#000000", strokeWidthPx: 0.7, name: "Witness2Line" }));

  sigLine(rightColX, bottomY + 78, `${sigLabels.second} SIGN/S`);

  return out.join("");
}
