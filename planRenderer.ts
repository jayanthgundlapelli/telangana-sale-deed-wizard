// planRenderer.ts
// -----------------------------------------------------------------------------
// FULL-PAGE "PLAN FOR REGISTRATION" generator (Telangana property registration).
//
// Strategy: "Deterministic render + AI extract".
//   1) A Gemini vision call reads the hand-drawn sketch and returns STRUCTURED
//      JSON (title text, property description, the to-scale plot geometry as a
//      polygon + labels in a 0..1000 space, interior structures, neighbours,
//      roads, and the AREA/PLINTH/SCALE table values).
//   2) This module renders that JSON into a crisp, vector A4 one-pager SVG that
//      matches the official proforma — title, property description, party
//      paragraphs (VENDOR/VENDEE or DONOR/DONEE etc. per transaction type),
//      the dimensioned site drawing, the AREA/PLINTH/SCALE/INDEX table, a north
//      arrow, and DONOR/DONEE/WITNESS signature blocks.
//
// The drawing is DYNAMIC: whatever shape, dimensions, neighbour names and roads
// the sketch contains are reproduced faithfully as clean lines/text. The page
// scaffolding (title/description/parties/table/signatures) is deterministic and
// filled from the registration form details (authoritative) with sketch-
// extracted text as fallback — so nothing is fabricated.
// -----------------------------------------------------------------------------

// Mirror of the @google/genai schema Type enum (string values are accepted).
const T = {
  OBJECT: "OBJECT" as const,
  STRING: "STRING" as const,
  NUMBER: "NUMBER" as const,
  ARRAY: "ARRAY" as const,
};

// JSON Schema handed to Gemini so the vision extraction is strongly typed.
export const PLAN_EXTRACTION_SCHEMA: any = {
  type: T.OBJECT,
  properties: {
    title: { type: T.STRING, description: "Heading, usually 'PLAN FOR REGISTRATION'." },
    propertyDescription: {
      type: T.STRING,
      description:
        "The descriptive sentence under the title (structure type + gram panchayat house no + village/mandal). Empty string if none.",
    },
    structureType: {
      type: T.STRING,
      description: "Main structure keyword e.g. 'TINSHED', 'R.C.C. BUILDING', 'OPEN PLOT'.",
    },
    parties: {
      type: T.ARRAY,
      description: "Party blocks exactly as written (DONOR/S, DONEE/S, VENDOR/S, VENDEE/S).",
      items: {
        type: T.OBJECT,
        properties: {
          role: { type: T.STRING },
          detail: { type: T.STRING },
        },
        required: ["role", "detail"],
      },
    },
    table: {
      type: T.OBJECT,
      properties: {
        totalAreaSqYds: { type: T.STRING },
        totalAreaSqMtrs: { type: T.STRING },
        plinthLabel: { type: T.STRING, description: "e.g. 'TINSHED' or 'R.C.C.'" },
        plinthAreaSqFts: { type: T.STRING },
        scale: { type: T.STRING, description: "e.g. '1\":20'" },
      },
    },
    drawing: {
      type: T.OBJECT,
      description: "Site drawing geometry in a 0..1000 x 0..1000 space (origin top-left, matching the image).",
      properties: {
        polygon: {
          type: T.ARRAY,
          description: "Outer plot boundary corner points, in order (clockwise).",
          items: {
            type: T.OBJECT,
            properties: { x: { type: T.NUMBER }, y: { type: T.NUMBER } },
            required: ["x", "y"],
          },
        },
        interiorBoxes: {
          type: T.ARRAY,
          description: "Inner structures (TINSHED / R.C.C.) as axis-aligned boxes.",
          items: {
            type: T.OBJECT,
            properties: {
              x: { type: T.NUMBER },
              y: { type: T.NUMBER },
              w: { type: T.NUMBER },
              h: { type: T.NUMBER },
              label: { type: T.STRING },
            },
            required: ["x", "y", "w", "h", "label"],
          },
        },
        labels: {
          type: T.ARRAY,
          description:
            "All text on/around the drawing: edge dimensions (42', 48'-3\"), neighbour names, road names, interior labels (OPEN PLACE).",
          items: {
            type: T.OBJECT,
            properties: {
              x: { type: T.NUMBER },
              y: { type: T.NUMBER },
              text: { type: T.STRING },
              rotation: { type: T.NUMBER, description: "Degrees; -90 for vertical road text on the left side." },
              role: { type: T.STRING, description: "dimension | neighbour | road | interior | other" },
            },
            required: ["x", "y", "text"],
          },
        },
      },
    },
  },
  required: ["title", "drawing"],
};

export const PLAN_EXTRACTION_PROMPT = `You are a meticulous land surveyor digitising a hand-drawn Telangana property registration sketch.

Look at the sketch image and extract its content as STRUCTURED DATA (not a drawing).

RULES:
- IGNORE anything struck-off, crossed-out, scribbled, or bird-like signature scribbles. Do NOT transcribe them.
- Transcribe every VISIBLE dimension exactly as written, keeping feet/inch marks (e.g. 42', 48'-3", 19'-9", 13'-10").
- Read neighbour names (e.g. "HOUSE OF CHAKALI CHANDRAVVA"), road names (e.g. "40' ROAD", "12' ROAD"), and interior labels ("OPEN PLACE", "TINSHED", "R.C.C.").
- Provide the plot outline as an ordered POLYGON of corner points in a 0..1000 coordinate space where (0,0) is the TOP-LEFT of the sketch's drawing area and (1000,1000) is the bottom-right. Use the ACTUAL drawn shape (it may be an irregular quadrilateral, not a perfect rectangle).
- Place each label at the (x,y) where it appears in that same 0..1000 space. For text written vertically along the left side, set rotation to -90.
- Inner structures (TINSHED / R.C.C.) go in interiorBoxes as {x,y,w,h} in the same space.
- Fill the AREA / PLINTH / SCALE table values if written on the sketch; otherwise leave them as empty strings.
- Copy the title, the property-description sentence, and each party block (DONOR/S, DONEE/S, VENDOR/S, VENDEE/S) verbatim into parties[].

Return ONLY the JSON matching the provided schema.`;

// ---- helpers ----------------------------------------------------------------
// Escape only what XML text CONTENT requires. esc() output is used exclusively
// between >...< (never inside an attribute), so quotes/feet-inch marks (', ")
// can stay literal — keeping dimension labels like 48'-3" readable.
function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Greedy word-wrap: returns lines that fit within maxWidth px at the given font size.
// The text rendered through this (title, description, party paragraphs) is
// effectively ALL-UPPERCASE, and uppercase serif glyphs are noticeably wider than
// the mixed-case average — so we size for caps (0.6 / bold 0.64) to avoid the last
// word overflowing the page border. (The title underline at 0.6 confirms the fit.)
function wrap(text: string, maxWidth: number, fontSize: number, boldish = false): string[] {
  const charW = fontSize * (boldish ? 0.64 : 0.6); // avg uppercase-serif glyph width
  const maxChars = Math.max(6, Math.floor(maxWidth / charW));
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

// Transaction-type -> the two party role labels used on the plan.
export function partyRoleLabels(nature?: string): { first: string; second: string } {
  const n = (nature || "").toLowerCase();
  if (n.includes("gift")) return { first: "DONOR/S", second: "DONEE/S" };
  if (n.includes("mortgage")) return { first: "MORTGAGOR/S", second: "MORTGAGEE/S" };
  if (n.includes("lease")) return { first: "LESSOR/S", second: "LESSEE/S" };
  if (n.includes("exchange")) return { first: "FIRST PARTY/S", second: "SECOND PARTY/S" };
  if (n.includes("release") || n.includes("relinquish"))
    return { first: "RELEASOR/S", second: "RELEASEE/S" };
  if (n.includes("settlement")) return { first: "SETTLOR/S", second: "SETTLEE/S" };
  return { first: "VENDOR/S", second: "VENDEE/S" }; // sale (default)
}

// Build a party paragraph line from a form person object.
function personLine(p: any): string {
  if (!p) return "";
  const bits: string[] = [];
  const nameRel = [p.name, p.relation].filter(Boolean).join(" ");
  if (nameRel) bits.push(nameRel);
  if (p.age) bits.push(`AGED ${p.age} YEARS`);
  if (p.occupation) bits.push(`OCCU: ${p.occupation}`);
  if (p.address) bits.push(`R/O ${p.address}`);
  return bits.join(", ").toUpperCase() + (bits.length ? "." : "");
}

export interface RenderInput {
  plan?: any | null; // extracted sketch JSON (may be null)
  details?: any | null; // consolidated registration form details
}

// ---- main renderer ----------------------------------------------------------
export function renderRegistrationPlanSvg(input: RenderInput): string {
  const plan = input.plan || {};
  const d = input.details || {};
  const prop = d.property || {};
  const drawing = plan.drawing || {};

  const W = 800;
  const H = 1131; // A4 portrait ratio
  const M = 22; // outer margin
  const contentX = M + 14;
  const contentW = W - 2 * (M + 14);

  const S: string[] = [];
  S.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet" font-family="'Times New Roman', Times, serif">`
  );
  S.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  // Double outer border (proforma look).
  S.push(`<rect x="${M}" y="${M}" width="${W - 2 * M}" height="${H - 2 * M}" fill="none" stroke="#000" stroke-width="2"/>`);
  S.push(`<rect x="${M + 5}" y="${M + 5}" width="${W - 2 * M - 10}" height="${H - 2 * M - 10}" fill="none" stroke="#000" stroke-width="0.8"/>`);

  let y = M + 46;

  // ---- Title ----
  const title = (plan.title || "PLAN FOR REGISTRATION").toUpperCase();
  S.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="27" font-weight="bold">${esc(title)}</text>`);
  const titleW = title.length * 27 * 0.6;
  S.push(`<line x1="${W / 2 - titleW / 2}" y1="${y + 5}" x2="${W / 2 + titleW / 2}" y2="${y + 5}" stroke="#000" stroke-width="1.2"/>`);
  y += 30;

  // ---- Property description ----
  const descType = plan.structureType || "";
  const desc =
    (plan.propertyDescription && plan.propertyDescription.trim()) ||
    [
      "THE",
      descType ? descType.toUpperCase() : "PROPERTY",
      prop.hNo ? `BEARING GRAM PANCHAYAT HOUSE NO.${prop.hNo},` : "",
      prop.village ? `SITUATED AT ${String(prop.village).toUpperCase()}` : "",
      prop.mandal ? `V/O ${String(prop.mandal).toUpperCase()} MANDAL.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  for (const ln of wrap(desc, contentW, 16)) {
    S.push(`<text x="${contentX}" y="${y}" font-size="16">${esc(ln)}</text>`);
    y += 21;
  }
  y += 10;

  // ---- Party paragraphs (role adapts to transaction type) ----
  const roles = partyRoleLabels(d.natureOfTransaction || d.propertyType);
  const sellers: any[] = Array.isArray(d.executants) ? d.executants : [];
  const buyers: any[] = Array.isArray(d.claimants) ? d.claimants : [];

  const firstDetail =
    sellers.map(personLine).filter(Boolean).join(" AND ") ||
    (plan.parties || []).find((p: any) => /vendor|donor|mortgagor|lessor|first|releasor|settlor/i.test(p.role))?.detail ||
    "";
  const secondDetail =
    buyers.map(personLine).filter(Boolean).join(" AND ") ||
    (plan.parties || []).find((p: any) => /vendee|donee|mortgagee|lessee|second|releasee|settlee/i.test(p.role))?.detail ||
    "";

  const emitParty = (label: string, detail: string) => {
    if (!detail) return;
    const labelTxt = `${label}: `;
    const labelW = labelTxt.length * 16 * 0.62;
    // First line: bold underlined label + start of detail.
    const firstLineWidth = contentW - labelW;
    const detailLines = wrap(detail, contentW, 16);
    // Re-wrap: first line must fit firstLineWidth.
    const firstLine = wrap(detail, firstLineWidth, 16)[0] || "";
    const rest = detail.slice(firstLine.length).trim();
    S.push(`<text x="${contentX}" y="${y}" font-size="16" font-weight="bold" text-decoration="underline">${esc(labelTxt)}</text>`);
    S.push(`<text x="${contentX + labelW}" y="${y}" font-size="16">${esc(firstLine)}</text>`);
    y += 21;
    for (const ln of wrap(rest, contentW, 16)) {
      if (!ln) continue;
      S.push(`<text x="${contentX}" y="${y}" font-size="16">${esc(ln)}</text>`);
      y += 21;
    }
    y += 8;
    void detailLines;
  };
  emitParty(roles.first, firstDetail);
  emitParty(roles.second, secondDetail);

  // ================= DRAWING + TABLE ROW =================
  // Sit just below the party paragraphs (small min so short blocks don't leave
  // a big void), but never so low the table+signatures overflow the page.
  const rowTop = Math.max(y + 18, 300);
  // Drawing region (left).
  const RX = contentX + 6;
  const RY = rowTop + 10;
  const RW = 410;
  const RH = 340;
  // Parse all drawing geometry up front so we can auto-fit it to the region.
  const poly: any[] = Array.isArray(drawing.polygon) ? drawing.polygon.filter((p: any) => p && isFinite(p.x) && isFinite(p.y)) : [];
  const boxes: any[] = Array.isArray(drawing.interiorBoxes) ? drawing.interiorBoxes : [];
  const labels: any[] = Array.isArray(drawing.labels) ? drawing.labels : [];

  // AUTO-FIT: the model is free to place the sketch anywhere in 0..1000 space and
  // is not consistent about which sub-range it uses (one run may fill 0..1000,
  // another may cram everything into 150..780). A fixed 0..1000→region map would
  // then leave the drawing tiny in a corner. Instead we measure the bounding box
  // of EVERYTHING we're about to draw (polygon vertices, interior-box corners,
  // label anchors) and scale that box uniformly to fill the region — so the plan
  // always fills the space cleanly and edge labels never clip, whatever range the
  // model chose. Uniform scale (min of the two axes) preserves the plot's shape.
  const clamp01k = (v: number) => Math.max(0, Math.min(1000, v));
  const fitPts: { x: number; y: number }[] = [];
  for (const p of poly) fitPts.push({ x: clamp01k(p.x), y: clamp01k(p.y) });
  for (const bx of boxes) {
    if ([bx?.x, bx?.y, bx?.w, bx?.h].every((v: any) => isFinite(v))) {
      fitPts.push({ x: clamp01k(bx.x), y: clamp01k(bx.y) });
      fitPts.push({ x: clamp01k(bx.x + bx.w), y: clamp01k(bx.y + bx.h) });
    }
  }
  for (const lb of labels) {
    if (lb && lb.text && isFinite(lb.x) && isFinite(lb.y)) fitPts.push({ x: clamp01k(lb.x), y: clamp01k(lb.y) });
  }
  let minX = 0, minY = 0, maxX = 1000, maxY = 1000;
  if (fitPts.length) {
    minX = Math.min(...fitPts.map((p) => p.x));
    minY = Math.min(...fitPts.map((p) => p.y));
    maxX = Math.max(...fitPts.map((p) => p.x));
    maxY = Math.max(...fitPts.map((p) => p.y));
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const FITPAD = 18; // px of breathing room inside the region so edge labels aren't clipped
  const availW = Math.max(1, RW - FITPAD * 2);
  const availH = Math.max(1, RH - FITPAD * 2);
  const fitScale = Math.min(availW / spanX, availH / spanY);
  const offX = RX + FITPAD + (availW - spanX * fitScale) / 2;
  const offY = RY + FITPAD + (availH - spanY * fitScale) / 2;
  const mapX = (px: number) => offX + (clamp01k(px) - minX) * fitScale;
  const mapY = (py: number) => offY + (clamp01k(py) - minY) * fitScale;

  if (poly.length >= 3) {
    const pts = poly.map((p) => `${mapX(p.x).toFixed(1)},${mapY(p.y).toFixed(1)}`).join(" ");
    S.push(`<polygon points="${pts}" fill="none" stroke="#000" stroke-width="2.4"/>`);
  } else {
    // Fallback rectangle from boundary/extent data.
    S.push(`<rect x="${RX + 40}" y="${RY + 30}" width="${RW - 90}" height="${RH - 90}" fill="none" stroke="#000" stroke-width="2.4"/>`);
    const b = prop.boundaries || {};
    if (b.north) S.push(`<text x="${RX + RW / 2}" y="${RY + 20}" text-anchor="middle" font-size="13">${esc(b.north)}</text>`);
    if (b.south) S.push(`<text x="${RX + RW / 2}" y="${RY + RH - 30}" text-anchor="middle" font-size="13">${esc(b.south)}</text>`);
    if (b.west) S.push(`<text x="${RX + 18}" y="${RY + RH / 2}" font-size="13" transform="rotate(-90 ${RX + 18} ${RY + RH / 2})" text-anchor="middle">${esc(b.west)}</text>`);
    if (b.east) S.push(`<text x="${RX + RW - 18}" y="${RY + RH / 2}" font-size="13" transform="rotate(-90 ${RX + RW - 18} ${RY + RH / 2})" text-anchor="middle">${esc(b.east)}</text>`);
  }

  // A white halo under drawing text keeps dimension marks legible where they sit
  // on/near the plot lines (paint-order="stroke" draws the white stroke first).
  const HALO = ' fill="#000" stroke="#ffffff" stroke-width="2.6" paint-order="stroke"';

  // Interior structure boxes (scaled by the same auto-fit transform). Record each
  // box's mapped rect + normalised label so we can suppress a duplicate free label.
  const norm = (s: string) => String(s || "").replace(/[\s.]/g, "").toUpperCase();
  const boxRects: { x0: number; y0: number; x1: number; y1: number; label: string }[] = [];
  for (const bx of boxes) {
    if (![bx?.x, bx?.y, bx?.w, bx?.h].every((v) => isFinite(v))) continue;
    const x0 = mapX(bx.x), y0 = mapY(bx.y), w0 = Math.abs(bx.w) * fitScale, h0 = Math.abs(bx.h) * fitScale;
    S.push(`<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w0.toFixed(1)}" height="${h0.toFixed(1)}" fill="none" stroke="#000" stroke-width="1.6"/>`);
    if (bx.label) S.push(`<text x="${(x0 + w0 / 2).toFixed(1)}" y="${(y0 + h0 / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12"${HALO}>${esc(bx.label)}</text>`);
    boxRects.push({ x0, y0, x1: x0 + w0, y1: y0 + h0, label: norm(bx.label) });
  }

  // Region bounds for keeping label text inside the drawing box.
  const regL = RX + 4, regR = RX + RW - 4, regT = RY + 4, regB = RY + RH - 4;

  // Labels (dimensions, neighbours, roads, interior).
  for (const lb of labels) {
    if (!lb || !lb.text || !isFinite(lb.x) || !isFinite(lb.y)) continue;
    let lx = mapX(lb.x), ly = mapY(lb.y);
    let rot = isFinite(lb.rotation) ? lb.rotation : 0;
    const role = String(lb.role || "");
    const isSide = /neighbour|road/i.test(role);

    // (1) Suppress a free label that merely repeats an interior box's OWN label and
    //     sits inside that box — the model sometimes emits "R.C.C." both as the box
    //     label and as a separate label, producing two overlapping texts.
    if (
      boxRects.some(
        (r) => r.label && norm(lb.text) === r.label && lx >= r.x0 - 2 && lx <= r.x1 + 2 && ly >= r.y0 - 2 && ly <= r.y1 + 2
      )
    ) {
      continue;
    }

    // (2) Long side (east/west) neighbour/road labels that the model left HORIZONTAL
    //     overflow past the plot into the table. If such a label is anchored in the
    //     outer band (left/right ~16%) of the fitted plot, stand it up vertically —
    //     matching how correctly-tagged side labels (e.g. the west road) render.
    if (rot === 0 && isSide && lb.text.length > 6) {
      const nearLeft = lb.x <= minX + 0.16 * spanX;
      const nearRight = lb.x >= maxX - 0.16 * spanX;
      if (nearLeft || nearRight) rot = -90;
    }

    const fs = /dimension/i.test(role) ? 12 : 12.5;
    // Keep the anchor inside the region. For a rotated (vertical) label the text
    // grows along Y, so clamp Y with a half-length margin; otherwise clamp X.
    const halfLen = (lb.text.length * fs * 0.5) / 2;
    if (rot === -90 || rot === 90) {
      ly = Math.max(regT + halfLen, Math.min(regB - halfLen, ly));
      lx = Math.max(regL + 8, Math.min(regR - 8, lx));
    } else {
      lx = Math.max(regL + halfLen, Math.min(regR - halfLen, lx));
      ly = Math.max(regT + 6, Math.min(regB - 6, ly));
    }

    const transform = rot ? ` transform="rotate(${rot} ${lx.toFixed(1)} ${ly.toFixed(1)})"` : "";
    S.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="${fs}"${transform}${HALO}>${esc(lb.text)}</text>`);
  }

  // ---- Info table (right) : 2 cols x 3 rows ----
  const TX = RX + RW + 24;
  const TW = W - M - 14 - 6 - TX;
  const TY = RY;
  const colX = TX + TW / 2;
  const r1 = TY, r1b = TY + 34, r2 = TY + 110, r2b = TY + 144, r3 = TY + 200, r3b = TY + 290;
  const cell = (x: number, yy: number, w: number, h: number) =>
    S.push(`<rect x="${x}" y="${yy}" width="${w}" height="${h}" fill="none" stroke="#000" stroke-width="1.2"/>`);
  const tcenter = (x: number, yy: number, txt: string, size = 13, bold = false, underline = false) =>
    S.push(`<text x="${x}" y="${yy}" text-anchor="middle" font-size="${size}"${bold ? ' font-weight="bold"' : ""}${underline ? ' text-decoration="underline"' : ""}>${esc(txt)}</text>`);

  const tbl = plan.table || {};
  // The model is inconsistent: sometimes it returns a bare number ("484.00"),
  // sometimes the value WITH its unit already baked in ("484.00 SQ.YDS"). Strip
  // any trailing area-unit token so we can re-append the canonical unit exactly
  // once — otherwise the cell reads "484.00 SQ.YDS SQ.YDS".
  const stripUnit = (v: any) =>
    String(v ?? "").replace(/\s*sq\.?\s*(yds?|yards?|mtrs?|meters?|metres?|fts?|feet)\.?\s*$/i, "").trim();
  const areaYds = stripUnit(tbl.totalAreaSqYds || prop.extentSqYards || "");
  const areaMtrsRaw = stripUnit(tbl.totalAreaSqMtrs || "");
  const areaMtrs =
    areaMtrsRaw ||
    (areaYds && isFinite(parseFloat(areaYds)) ? (parseFloat(areaYds) * 0.836127).toFixed(2) : "");
  const plinthLabel = tbl.plinthLabel || plan.structureType || "";
  const plinthFts = stripUnit(tbl.plinthAreaSqFts || prop.plinthArea || "");
  const scale = tbl.scale || '1":20\'';

  // Row 1: TOTAL AREA | PLINTH AREA
  cell(TX, r1, TW / 2, r2 - r1);
  cell(colX, r1, TW / 2, r2 - r1);
  tcenter(TX + TW / 4, r1 + 22, "TOTAL AREA", 14, false, true);
  tcenter(colX + TW / 4, r1 + 22, "PLINTH AREA", 14, false, true);
  const areaLines = [areaYds ? `${areaYds} SQ.YDS` : "", areaYds && areaMtrs ? "OR EQU.TO" : "", areaMtrs ? `${areaMtrs} SQ.MTRS` : ""].filter(Boolean);
  areaLines.forEach((ln, i) => tcenter(TX + TW / 4, r1b + 20 + i * 18, ln, 12.5));
  const plinthLines = [plinthLabel && plinthFts ? `${plinthLabel}-${plinthFts}` : plinthFts || "", plinthFts ? "SQ.FTS" : ""].filter(Boolean);
  plinthLines.forEach((ln, i) => tcenter(colX + TW / 4, r1b + 20 + i * 18, ln, 12.5));

  // Row 2: SCALE | INDEX
  cell(TX, r2, TW / 2, r3 - r2);
  cell(colX, r2, TW / 2, r3 - r2);
  tcenter(TX + TW / 4, r2 + 22, "SCALE", 14, false, true);
  tcenter(colX + TW / 4, r2 + 22, "INDEX", 14, false, true);
  tcenter(TX + TW / 4, r2b + 20, scale, 13);
  // Index swatch + caption
  S.push(`<rect x="${colX + 12}" y="${r2b + 8}" width="30" height="14" fill="none" stroke="#000" stroke-width="1"/>`);
  S.push(`<text x="${colX + 48}" y="${r2b + 15}" font-size="11">PROPERTY</text>`);
  S.push(`<text x="${colX + 48}" y="${r2b + 30}" font-size="11">UNDER REGN</text>`);

  // Row 3: North arrow | (blank continuation)
  cell(TX, r3, TW / 2, r3b - r3);
  cell(colX, r3, TW / 2, r3b - r3);
  const ncx = TX + TW / 4, ncy = r3 + (r3b - r3) / 2;
  S.push(`<circle cx="${ncx}" cy="${ncy}" r="26" fill="none" stroke="#000" stroke-width="1.4"/>`);
  S.push(`<path d="M ${ncx} ${ncy + 16} L ${ncx} ${ncy - 16} M ${ncx - 6} ${ncy - 8} L ${ncx} ${ncy - 16} L ${ncx + 6} ${ncy - 8}" fill="none" stroke="#000" stroke-width="1.6"/>`);
  S.push(`<text x="${ncx + 12}" y="${ncy - 6}" font-size="13" font-weight="bold">N</text>`);

  // ================= SIGNATURE BLOCKS (bottom) =================
  const sigX = colX - 6;
  let sy = r3b + 70;
  const sig = (label: string) => {
    const w2 = label.length * 13 * 0.62;
    S.push(`<text x="${sigX}" y="${sy}" font-size="13" font-weight="bold">${esc(label)}</text>`);
    S.push(`<line x1="${sigX}" y1="${sy + 4}" x2="${sigX + w2}" y2="${sy + 4}" stroke="#000" stroke-width="0.8"/>`);
  };
  sig(`${roles.first} SIGN/S`);
  sy += 90;
  sig(`${roles.second} SIGN/S`);
  sy += 24;
  S.push(`<text x="${sigX}" y="${sy}" font-size="13" font-weight="bold" text-decoration="underline">WITNESSESS.</text>`);
  sy += 34;
  S.push(`<text x="${sigX + 6}" y="${sy}" font-size="13">1.</text>`);
  sy += 34;
  S.push(`<text x="${sigX + 6}" y="${sy}" font-size="13">2.</text>`);

  S.push(`</svg>`);
  return S.join("\n");
}

export function renderPlanDataUrl(input: RenderInput): string {
  const svg = renderRegistrationPlanSvg(input);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
