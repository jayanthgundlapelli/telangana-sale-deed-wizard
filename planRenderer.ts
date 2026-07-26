// planRenderer.ts
// -----------------------------------------------------------------------------
// FULL-PAGE "PLAN FOR REGISTRATION" generator (Telangana property registration).
//
// Strategy: "AI extracts MEASUREMENTS → we RECONSTRUCT the geometry."
//   1) A Gemini vision call reads the hand-drawn sketch and returns STRUCTURED
//      JSON — but crucially NOT a traced polygon. It returns, per boundary side,
//      the COMPASS direction, the REAL length in feet, and the neighbour name;
//      the north-arrow orientation; and each abutting road's width in feet.
//   2) This module RECONSTRUCTS the plot polygon from those real measurements
//      using surveying rules, then renders a crisp, to-scale vector A4 one-pager.
//
// Why reconstruct instead of trace?  A hand sketch is not to scale: a plot whose
// four sides are all "60'" is drawn as a lopsided blob, and tracing it yields a
// lopsided blob. Town-planning/drafting practice is the opposite — the drawing is
// DERIVED from the measurements. So we:
//   • place the NORTH side on top ALWAYS (north-up is the universal site-plan
//     convention), regardless of how the sketch happened to be oriented;
//   • build the shape from side lengths — equal sides ⇒ a true square, opposite
//     sides equal ⇒ a true rectangle, otherwise a faithful right-angled
//     quadrilateral (a quadrilateral is NOT fixed by its 4 side lengths alone —
//     it "flexes" — so with no bearings we use the standard rectilinear/right-
//     angle assumption; when bearings ARE given we close a coordinate traverse);
//   • draw abutting roads TO SCALE — a 40' road reads ~3.3× wider than a 12' one,
//     using the SAME feet→pixel scale as the plot.
//
// The page scaffolding (title / description / parties / area table / signatures)
// is deterministic and filled from the registration form details (authoritative)
// with sketch-extracted text as fallback — so nothing is fabricated.
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
      description:
        "The site geometry expressed as MEASUREMENTS (not a traced picture). We reconstruct the drawing from these, north-up and to scale.",
      properties: {
        northDirection: {
          type: T.OBJECT,
          description: "Where geographic NORTH points in the sketch image, read from the drawn north arrow / compass rose.",
          properties: {
            imageClockDeg: {
              type: T.NUMBER,
              description:
                "Degrees CLOCKWISE from image-up that the north arrow points: 0 = up, 90 = right, 180 = down, 270 = left. Use 0 if the arrow points up or none is drawn.",
            },
            found: { type: T.STRING, description: "'yes' if a north arrow/compass is actually drawn on the sketch, else 'no'." },
          },
        },
        plot: {
          type: T.OBJECT,
          description:
            "The plot boundary described by its SIDES with real measurements, so it can be reconstructed to scale with North up.",
          properties: {
            shape: {
              type: T.STRING,
              description:
                "Your read of the TRUE shape from the dimensions: 'square' (all four sides ~equal), 'rectangle' (opposite sides equal), 'trapezoid', or 'irregular'.",
            },
            sides: {
              type: T.ARRAY,
              description:
                "One entry per boundary side of the plot. Use the sketch's north arrow to decide which compass side each edge lies on.",
              items: {
                type: T.OBJECT,
                properties: {
                  direction: {
                    type: T.STRING,
                    description: "Compass side of the plot this edge forms: NORTH, SOUTH, EAST, or WEST.",
                  },
                  lengthLabel: {
                    type: T.STRING,
                    description: "The dimension text written on that edge, verbatim, e.g. \"48'-3\\\"\" or \"66'\".",
                  },
                  lengthFeet: {
                    type: T.NUMBER,
                    description: "That dimension converted to DECIMAL FEET, e.g. 48'-3\" -> 48.25, 66' -> 66.",
                  },
                  bearingDeg: {
                    type: T.NUMBER,
                    description: "Azimuth of the edge in degrees clockwise from North IF a bearing is written on the sketch; else 0.",
                  },
                  neighbour: {
                    type: T.STRING,
                    description: "Abutting owner/feature named outside this side, e.g. \"HOUSE OF CHAKALI CHANDRAVVA\". Empty if none.",
                  },
                },
                required: ["direction", "lengthFeet"],
              },
            },
          },
        },
        roads: {
          type: T.ARRAY,
          description: "Roads abutting the plot; one entry per road. Give the width in feet so we can draw it TO SCALE.",
          items: {
            type: T.OBJECT,
            properties: {
              side: {
                type: T.STRING,
                description:
                  "Which side of the PLOT the road runs along: NORTH, SOUTH, EAST or WEST (per the sketch's north arrow).",
              },
              label: { type: T.STRING, description: "Road name/width exactly as written, e.g. \"40' ROAD\"." },
              widthFeet: {
                type: T.NUMBER,
                description: "Road width in DECIMAL FEET (e.g. \"40' ROAD\" -> 40, \"12' WIDE ROAD\" -> 12). 0 if unknown.",
              },
            },
            required: ["side", "label"],
          },
        },
        interiorStructures: {
          type: T.ARRAY,
          description: "Structures inside the plot (TINSHED / R.C.C. / OPEN PLACE), with real dimensions if written.",
          items: {
            type: T.OBJECT,
            properties: {
              label: { type: T.STRING },
              widthFeet: { type: T.NUMBER, description: "East-west size in feet, 0 if unknown." },
              depthFeet: { type: T.NUMBER, description: "North-south size in feet, 0 if unknown." },
              position: {
                type: T.STRING,
                description: "Where inside the plot: center, north, south, east, west, northeast, northwest, southeast, southwest.",
              },
            },
            required: ["label"],
          },
        },
        // ---- Fallback geometry (used only if `plot.sides` is missing/insufficient) ----
        polygon: {
          type: T.ARRAY,
          description:
            "FALLBACK ONLY: outer plot corner points in order (clockwise) in a 0..1000 space, if you cannot give sides[].",
          items: {
            type: T.OBJECT,
            properties: { x: { type: T.NUMBER }, y: { type: T.NUMBER } },
            required: ["x", "y"],
          },
        },
        labels: {
          type: T.ARRAY,
          description: "FALLBACK ONLY: free text on/around the drawing (dimensions, neighbours) at (x,y) in the same 0..1000 space.",
          items: {
            type: T.OBJECT,
            properties: {
              x: { type: T.NUMBER },
              y: { type: T.NUMBER },
              text: { type: T.STRING },
              rotation: { type: T.NUMBER },
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

export const PLAN_EXTRACTION_PROMPT = `You are a meticulous land surveyor and town-planning draftsman digitising a hand-drawn Telangana property registration sketch.

Read the sketch and extract its content as STRUCTURED MEASUREMENTS — do NOT try to trace the exact drawn shape (hand sketches are not to scale). We will REDRAW the plot to scale from your measurements.

CRITICAL RULES:
- IGNORE anything struck-off, crossed-out, scribbled, or signature squiggles. Do NOT transcribe them.
- FIND THE NORTH ARROW / compass. Report which way it points as degrees clockwise from image-up in drawing.northDirection.imageClockDeg (0=up, 90=right, 180=down, 270=left), and set found to 'yes' or 'no'. If none is drawn, use 0 / 'no'.
- For EACH boundary side of the plot, add an entry to drawing.plot.sides with:
    • direction  = the COMPASS side it lies on (NORTH / SOUTH / EAST / WEST), decided using the north arrow above;
    • lengthLabel = the dimension written on that edge, verbatim, keeping feet/inch marks (e.g. 48'-3", 66', 19'-9");
    • lengthFeet  = that dimension in decimal feet (48'-3" -> 48.25, 66' -> 66, 19'-9" -> 19.75);
    • neighbour   = the abutter named outside that side (e.g. "HOUSE OF CHAKALI CHANDRAVVA"), else empty.
  Most plots have exactly 4 sides (NORTH, SOUTH, EAST, WEST). If a bearing/angle is written on an edge, put it in bearingDeg (clockwise from North), else 0.
- Set drawing.plot.shape to 'square' if all sides are about equal, 'rectangle' if opposite sides are equal, else 'trapezoid' or 'irregular'.
- For EVERY road bordering the plot, add drawing.roads with its side (NORTH/SOUTH/EAST/WEST), its label verbatim ("40' ROAD"), and widthFeet in decimal feet so we can draw it to scale (a 40' road must read wider than a 12' road).
- Put inner structures (TINSHED / R.C.C. / OPEN PLACE) in drawing.interiorStructures with real widthFeet/depthFeet if written (else 0) and a position keyword.
- Copy the title, the property-description sentence, and each party block (DONOR/S, DONEE/S, VENDOR/S, VENDEE/S) verbatim into parties[]. Fill the AREA/PLINTH/SCALE table values if written, else leave empty strings.
- Only if you truly cannot identify the sides, fall back to giving drawing.polygon (ordered corners, 0..1000 space) and drawing.labels.

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

// ---- surveying helpers -------------------------------------------------------

// Parse a feet/inch dimension string into decimal feet.
//   "48'-3\""  -> 48.25   |  "66'" -> 66  |  "19'-9\"" -> 19.75  |  "13' 10\"" -> 13.833
//   bare "48"  -> 48      |  "48.5'" -> 48.5
// Returns null when nothing numeric is present.
export function parseFeet(s: any): number | null {
  if (s == null) return null;
  const str = String(s).replace(/[′’]/g, "'").replace(/[″”]/g, '"').trim();
  if (!str) return null;
  const feetM = str.match(/(\d+(?:\.\d+)?)\s*'/);
  const inchM = str.match(/(\d+(?:\.\d+)?)\s*"/);
  let feet: number | null = feetM ? parseFloat(feetM[1]) : null;
  const inch = inchM ? parseFloat(inchM[1]) : 0;
  if (feet == null) {
    const bare = str.match(/(\d+(?:\.\d+)?)/);
    if (!bare) return null;
    feet = parseFloat(bare[1]);
  }
  const val = feet + (isFinite(inch) ? inch : 0) / 12;
  return isFinite(val) && val > 0 ? val : null;
}

// Normalise a compass word/letter to a single cardinal N/S/E/W ("" if unknown).
function normDir(s: any): "N" | "S" | "E" | "W" | "" {
  const t = String(s || "").trim().toUpperCase();
  if (!t) return "";
  if (t.startsWith("NORTH") || t === "N") return "N";
  if (t.startsWith("SOUTH") || t === "S") return "S";
  if (t.startsWith("EAST") || t === "E") return "E";
  if (t.startsWith("WEST") || t === "W") return "W";
  return "";
}

interface SideInfo {
  lengthFeet: number;
  label: string;
  neighbour: string;
  fromForm?: boolean; // neighbour text came from the FORM boundaries, not the sketch
}
type ByDir = { N?: SideInfo; S?: SideInfo; E?: SideInfo; W?: SideInfo };
interface Pt {
  x: number; // East (+right)
  y: number; // North (+up)
}

// Reconstruct a rectilinear plot polygon (feet coordinates, x=East, y=North-up)
// from the four boundary side lengths, using the standard right-angle assumption.
//
// A quadrilateral is NOT determined by its 4 side lengths alone (it flexes), so
// without bearings we assume right-ish angles — which is what registration plots
// almost always are. Consequences (exactly the behaviour asked for):
//   • all four sides equal            -> a true SQUARE
//   • opposite sides equal (N=S,E=W)  -> a true RECTANGLE
//   • N≠S (or E≠W)                    -> a symmetric TRAPEZOID honouring both
//                                         parallel edges, with height = avg of the
//                                         two vertical sides.
// Corners returned clockwise from top-left: TL, TR, BR, BL (north edge on top).
function reconstructRectilinear(byDir: ByDir): { corners: Pt[] } | null {
  const N = byDir.N?.lengthFeet;
  const S = byDir.S?.lengthFeet;
  const E = byDir.E?.lengthFeet;
  const W = byDir.W?.lengthFeet;
  // Horizontal (top/bottom) extents; vertical (left/right) extents. Fill a
  // missing side from its opposite so a 3-sided read still draws sensibly.
  const top = (N && N > 0 ? N : S) || 0; // north edge length
  const bottom = (S && S > 0 ? S : N) || 0; // south edge length
  const right = (E && E > 0 ? E : W) || 0; // east edge length
  const left = (W && W > 0 ? W : E) || 0; // west edge length
  if (!(top > 0) || !(right > 0)) return null; // not enough to build a shape
  const height = left > 0 && right > 0 ? (left + right) / 2 : right || left;
  if (!(height > 0)) return null;
  const TL: Pt = { x: -top / 2, y: height };
  const TR: Pt = { x: top / 2, y: height };
  const BR: Pt = { x: bottom / 2, y: 0 };
  const BL: Pt = { x: -bottom / 2, y: 0 };
  return { corners: [TL, TR, BR, BL] };
}

// Close a coordinate traverse from per-side bearings + lengths (feet). Used only
// when the sketch actually carries bearings. Bearing is azimuth clockwise from
// North; a leg advances the pen by (ΔE, ΔN) = (L·sin θ, L·cos θ). Returns the
// vertices (feet, x=East, y=North-up) or null if fewer than 3 valid legs.
function closeTraverse(legs: { lengthFeet: number; bearingDeg: number }[]): Pt[] | null {
  const good = legs.filter((l) => l && l.lengthFeet > 0 && isFinite(l.bearingDeg));
  if (good.length < 3) return null;
  const pts: Pt[] = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  for (const l of good) {
    const th = (l.bearingDeg * Math.PI) / 180;
    x += l.lengthFeet * Math.sin(th);
    y += l.lengthFeet * Math.cos(th);
    pts.push({ x, y });
  }
  // Drop the duplicate closing point if the traverse returns near the origin.
  const last = pts[pts.length - 1];
  if (Math.hypot(last.x, last.y) < 0.02 * (Math.abs(x) + Math.abs(y) + 1)) pts.pop();
  return pts.length >= 3 ? pts : null;
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
  // Cross-hatch (45° + 135° diamond grid) is the standard "property under
  // registration" fill per drafting convention. Kept thin/light so bold dimension
  // text (with its white halo) stays legible over it.
  S.push(
    `<defs>` +
      `<pattern id="propHatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="10" height="10" fill="#ffffff"/>` +
      `<line x1="0" y1="0" x2="0" y2="10" stroke="#6b8b87" stroke-width="0.6"/>` +
      `<line x1="0" y1="0" x2="10" y2="0" stroke="#6b8b87" stroke-width="0.6"/>` +
      `</pattern>` +
      `</defs>`
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
    const firstLineWidth = contentW - labelW;
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
  };
  emitParty(roles.first, firstDetail);
  emitParty(roles.second, secondDetail);

  // ================= DRAWING + TABLE ROW =================
  const rowTop = Math.max(y + 18, 300);
  const RX = contentX + 6; // drawing region (left)
  const RY = rowTop + 10;
  const RW = 410;
  const RH = 340;

  // A white halo under drawing text keeps marks legible over lines/hatching
  // (paint-order="stroke" draws the white stroke first, then the black fill).
  const HALO = ' fill="#000" stroke="#ffffff" stroke-width="2.6" paint-order="stroke"';

  // ---- Gather measurements -------------------------------------------------
  const rawSides: any[] = Array.isArray(drawing?.plot?.sides) ? drawing.plot.sides : [];
  const byDir: ByDir = {};
  for (const s of rawSides) {
    const dir = normDir(s?.direction);
    if (!dir) continue;
    const len = isFinite(s?.lengthFeet) && s.lengthFeet > 0 ? s.lengthFeet : parseFeet(s?.lengthLabel);
    if (!(len && len > 0)) {
      // Keep the neighbour/label even when the length is missing.
      if (!byDir[dir]) byDir[dir] = { lengthFeet: 0, label: String(s?.lengthLabel || ""), neighbour: String(s?.neighbour || "") };
      continue;
    }
    // Prefer the first sensible reading per side; merge neighbour text if absent.
    if (!byDir[dir] || !(byDir[dir]!.lengthFeet > 0)) {
      byDir[dir] = { lengthFeet: len, label: String(s?.lengthLabel || `${Math.round(len)}'`), neighbour: String(s?.neighbour || "") };
    }
  }
  // Boundary neighbours from the form fill in ONLY where the sketch omitted them.
  // Marked fromForm so we can suppress them on any side the sketch drew a road on —
  // the sketch's own roads/neighbours are authoritative ("roads exactly as drawn").
  const formBounds = prop.boundaries || {};
  (["N", "S", "E", "W"] as const).forEach((k) => {
    const fb = k === "N" ? formBounds.north : k === "S" ? formBounds.south : k === "E" ? formBounds.east : formBounds.west;
    if (byDir[k] && !byDir[k]!.neighbour && fb) {
      byDir[k]!.neighbour = String(fb);
      byDir[k]!.fromForm = true;
    }
  });

  // Prefer a bearing-based closed traverse when bearings are present for enough
  // sides; otherwise reconstruct rectilinearly from the side lengths.
  const dirOrder: ("N" | "E" | "S" | "W")[] = ["N", "E", "S", "W"];
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

  // Region bounds for clamping text inside the drawing box.
  const regL = RX + 4, regR = RX + RW - 4, regT = RY + 4, regB = RY + RH - 4;

  if (cornersFeet && cornersFeet.length >= 3) {
    // ===== TO-SCALE, NORTH-UP RECONSTRUCTED DRAWING ==========================
    const roadsRaw: any[] = Array.isArray(drawing?.roads) ? drawing.roads : [];
    const roadBySide = new Map<"N" | "S" | "E" | "W", { label: string; widthFeet: number }>();
    for (const rd of roadsRaw) {
      const side = normDir(rd?.side);
      if (!side) continue;
      const wf = isFinite(rd?.widthFeet) && rd.widthFeet > 0 ? rd.widthFeet : parseFeet(rd?.label) || 0;
      if (!roadBySide.has(side)) roadBySide.set(side, { label: String(rd?.label || ""), widthFeet: wf });
    }

    // Plot bounding box (feet).
    const pxs = cornersFeet.map((p) => p.x);
    const pys = cornersFeet.map((p) => p.y);
    const pxMin = Math.min(...pxs), pxMax = Math.max(...pxs);
    const pyMin = Math.min(...pys), pyMax = Math.max(...pys);
    const plotWFeet = Math.max(1, pxMax - pxMin);
    const plotHFeet = Math.max(1, pyMax - pyMin);

    // Fit the PLOT into ~56% of the region, reserving the rest for to-scale road
    // bands + dimension/neighbour text on every side. Uniform scale preserves the
    // reconstructed shape (square stays square).
    const LABELPAD = 16; // px text breathing room at the region edge
    const innerW = Math.max(1, RW - 2 * LABELPAD);
    const innerH = Math.max(1, RH - 2 * LABELPAD);
    const sc = Math.min((innerW * 0.56) / plotWFeet, (innerH * 0.56) / plotHFeet); // feet -> px

    const plotWpx = plotWFeet * sc;
    const plotHpx = plotHFeet * sc;
    const cx = RX + RW / 2;
    const cy = RY + RH / 2;
    // Map feet (x=East, y=North-up) to SVG px (y grows downward): centre the plot.
    const mpx = (fx: number) => cx + (fx - (pxMin + pxMax) / 2) * sc;
    const mpy = (fy: number) => cy - (fy - (pyMin + pyMax) / 2) * sc;

    const plotL = cx - plotWpx / 2;
    const plotR = cx + plotWpx / 2;
    const plotT = cy - plotHpx / 2;
    const plotB = cy + plotHpx / 2;
    const plotMinPx = Math.min(plotWpx, plotHpx);

    // Roads: thickness is TRUE SCALE (widthFeet * sc) so relative widths are
    // faithful (40' reads ~3.3x a 12'), but clamp the largest so a very wide road
    // can't crowd out the plot — scaling all roads by the same factor keeps their
    // ratios intact. Min 6px so a thin road is still visible.
    const roadPxRaw = new Map<string, number>();
    let maxRoadPx = 0;
    for (const [side, info] of roadBySide) {
      const pxw = info.widthFeet > 0 ? info.widthFeet * sc : 12; // unknown width -> nominal
      roadPxRaw.set(side, pxw);
      if (pxw > maxRoadPx) maxRoadPx = pxw;
    }
    const roadCap = 0.5 * plotMinPx;
    const roadShrink = maxRoadPx > roadCap && maxRoadPx > 0 ? roadCap / maxRoadPx : 1;
    const roadGap = 6; // px gap between plot edge and road band

    // Draw road bands FIRST (under the plot outline & labels).
    const roadRects: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const [side, info] of roadBySide) {
      const band = Math.max(6, (roadPxRaw.get(side) || 12) * roadShrink);
      let rx = 0, ry = 0, rw = 0, rh = 0;
      if (side === "N") {
        rx = plotL; rw = plotWpx; rh = band; ry = plotT - roadGap - band;
      } else if (side === "S") {
        rx = plotL; rw = plotWpx; rh = band; ry = plotB + roadGap;
      } else if (side === "W") {
        ry = plotT; rh = plotHpx; rw = band; rx = plotL - roadGap - band;
      } else {
        ry = plotT; rh = plotHpx; rw = band; rx = plotR + roadGap;
      }
      // Keep inside the region.
      if (rx < regL) { rw -= regL - rx; rx = regL; }
      if (ry < regT) { rh -= regT - ry; ry = regT; }
      if (rx + rw > regR) rw = regR - rx;
      if (ry + rh > regB) rh = regB - ry;
      if (rw > 2 && rh > 2) {
        S.push(`<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="#e2e2e2" stroke="#000" stroke-width="0.8"/>`);
        roadRects[side] = { x: rx, y: ry, w: rw, h: rh };
        // Road label centered along the band; rotated for E/W bands.
        const label = info.label || (info.widthFeet > 0 ? `${Math.round(info.widthFeet)}' ROAD` : "ROAD");
        const tcx = rx + rw / 2, tcy = ry + rh / 2;
        if (side === "E" || side === "W") {
          S.push(`<text x="${tcx.toFixed(1)}" y="${tcy.toFixed(1)}" text-anchor="middle" font-size="11" transform="rotate(-90 ${tcx.toFixed(1)} ${tcy.toFixed(1)})"${HALO}>${esc(label)}</text>`);
        } else {
          S.push(`<text x="${tcx.toFixed(1)}" y="${(tcy + 4).toFixed(1)}" text-anchor="middle" font-size="11"${HALO}>${esc(label)}</text>`);
        }
      }
    }

    // Plot polygon: hatched fill (property under registration) + heavy boundary.
    const ptsStr = cornersFeet.map((p) => `${mpx(p.x).toFixed(1)},${mpy(p.y).toFixed(1)}`).join(" ");
    S.push(`<polygon points="${ptsStr}" fill="url(#propHatch)" stroke="#000" stroke-width="2.6" stroke-linejoin="miter"/>`);

    // Interior structures, drawn to scale where dimensions are given. Drawn in TWO
    // passes — all boxes first, then all labels — so a later box can never paint
    // over an earlier box's text (that clipped "R.C.C." to ".C.C." before). A
    // built structure (R.C.C./TINSHED/HOUSE) gets a solid white box; an OPEN/VACANT
    // region is left unfilled so the property hatch shows through (it is not a
    // building). Labels are shrunk to fit their box width so they never overflow.
    const interiors: any[] = Array.isArray(drawing?.interiorStructures) ? drawing.interiorStructures : [];
    type IB = { label: string; bx: number; by: number; bw: number; bh: number; boxed: boolean; open: boolean; tx: number; ty: number };
    const interiorBoxes: IB[] = [];
    for (const st of interiors) {
      const label = String(st?.label || "").trim();
      if (!label) continue;
      const open = /open|vacant|khali|ఖాళీ/i.test(label);
      const wF = isFinite(st?.widthFeet) && st.widthFeet > 0 ? st.widthFeet : 0;
      const dF = isFinite(st?.depthFeet) && st.depthFeet > 0 ? st.depthFeet : 0;
      const pos = String(st?.position || "center").toLowerCase();
      // Anchor point inside the plot bbox from the position keyword.
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
        interiorBoxes.push({ label, bx, by, bw, bh, boxed: !open, open, tx: bx + bw / 2, ty: by + bh / 2 });
      } else {
        interiorBoxes.push({ label, bx: ax, by: ay, bw: 0, bh: 0, boxed: false, open, tx: ax, ty: ay });
      }
    }
    // Pass 1: boxes (built structures only — open areas stay hatched).
    for (const b of interiorBoxes) {
      if (b.boxed && b.bw > 0 && b.bh > 0) {
        S.push(`<rect x="${b.bx.toFixed(1)}" y="${b.by.toFixed(1)}" width="${b.bw.toFixed(1)}" height="${b.bh.toFixed(1)}" fill="#ffffff" stroke="#000" stroke-width="1.4"/>`);
      }
    }
    // Pass 2: labels on top of every box, shrunk to fit the box width.
    for (const b of interiorBoxes) {
      let fs = 12;
      if (b.bw > 0) {
        // Serif glyphs ~0.6em wide; shrink so the label fits inside the box.
        const fit = (b.bw - 6) / Math.max(1, b.label.length * 0.6);
        fs = Math.max(7.5, Math.min(12, fit));
      }
      S.push(`<text x="${b.tx.toFixed(1)}" y="${(b.ty + fs * 0.34).toFixed(1)}" text-anchor="middle" font-size="${fs.toFixed(1)}"${HALO}>${esc(b.label)}</text>`);
    }

    // Edge midpoints (px) for dimension + neighbour labels. For the rectilinear
    // reconstruction the corners are [TL,TR,BR,BL]; derive edge mids generically.
    const edgeMid = (a: Pt, b: Pt) => ({ x: (mpx(a.x) + mpx(b.x)) / 2, y: (mpy(a.y) + mpy(b.y)) / 2 });
    const drawEdge = (dir: "N" | "S" | "E" | "W", a: Pt, b: Pt) => {
      const info = byDir[dir];
      const mid = edgeMid(a, b);
      const road = roadRects[dir];
      const vert = dir === "E" || dir === "W";
      // Dimension label sits JUST INSIDE the boundary line (drafting style). Inside
      // placement means it never collides with a road band outside, nor with the
      // neighbour name — the two used to overlap when both sat just outside.
      const dimIn = 15;
      let dimX = mid.x, dimY = mid.y;
      if (dir === "N") dimY = plotT + dimIn;
      else if (dir === "S") dimY = plotB - dimIn + 4;
      else if (dir === "W") dimX = plotL + dimIn;
      else dimX = plotR - dimIn;
      const dimLabel = info?.label || (info && info.lengthFeet > 0 ? `${Math.round(info.lengthFeet)}'` : "");
      if (dimLabel) {
        const tr = vert ? ` transform="rotate(-90 ${dimX.toFixed(1)} ${dimY.toFixed(1)})"` : "";
        S.push(`<text x="${dimX.toFixed(1)}" y="${dimY.toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="bold"${tr}${HALO}>${esc(dimLabel)}</text>`);
      }
      // Neighbour name sits OUTSIDE, beyond the road band if present. Suppress it
      // when a road band already labels this side (the band shows the road name),
      // or when the neighbour text is itself just "…ROAD" for a drawn road — that
      // was the duplicate "40' WIDE ROAD" + "40' ROAD" seen on the same edge.
      const neigh = info?.neighbour;
      const roadLike = /road|highway|street|lane|రోడ్/i.test(neigh || "");
      // Suppress the neighbour text when: (a) a road band already labels this side
      // and the neighbour is itself a road name (avoids "40' ROAD" twice), OR
      // (b) the neighbour came from the FORM boundaries but the SKETCH drew a road
      // here — the sketch's road wins, so a stale/foreign form neighbour must not
      // sit under the road band.
      if (neigh && !(road && roadLike) && !(road && info?.fromForm)) {
        let nx = mid.x, ny = mid.y;
        const beyond = 22;
        if (dir === "N") ny = (road ? road.y : plotT) - beyond;
        else if (dir === "S") ny = (road ? road.y + road.h : plotB) + beyond;
        else if (dir === "W") nx = (road ? road.x : plotL) - beyond;
        else nx = (road ? road.x + road.w : plotR) + beyond;
        nx = Math.max(regL + 6, Math.min(regR - 6, nx));
        ny = Math.max(regT + 10, Math.min(regB - 6, ny));
        const tr = vert ? ` transform="rotate(-90 ${nx.toFixed(1)} ${ny.toFixed(1)})"` : "";
        S.push(`<text x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" text-anchor="middle" font-size="11"${tr}${HALO}>${esc(neigh)}</text>`);
      }
    };
    // Map the four cardinal edges to corner pairs of the reconstructed polygon.
    // corners = [TL, TR, BR, BL] for the rectilinear build.
    if (cornersFeet.length === 4) {
      const [TL, TR, BR, BL] = cornersFeet;
      drawEdge("N", TL, TR);
      drawEdge("E", TR, BR);
      drawEdge("S", BR, BL);
      drawEdge("W", BL, TL);
    } else {
      // Traverse polygon (n-gon): label each side by its own bearing-derived dir.
      for (let i = 0; i < cornersFeet.length; i++) {
        const a = cornersFeet[i];
        const b = cornersFeet[(i + 1) % cornersFeet.length];
        const mid = edgeMid(a, b);
        const leg = bearingLegs[i];
        if (leg) {
          const lbl = `${Math.round(leg.lengthFeet)}'`;
          S.push(`<text x="${mid.x.toFixed(1)}" y="${(mid.y - 4).toFixed(1)}" text-anchor="middle" font-size="12"${HALO}>${esc(lbl)}</text>`);
        }
      }
    }

    // North arrow — ALWAYS points up (the plot is drawn north-up by construction).
    const naX = regR - 24, naY = regT + 30;
    S.push(`<circle cx="${naX}" cy="${naY}" r="18" fill="#ffffff" stroke="#000" stroke-width="1.2"/>`);
    S.push(`<path d="M ${naX} ${naY + 12} L ${naX} ${naY - 12} M ${naX - 5} ${naY - 5} L ${naX} ${naY - 12} L ${naX + 5} ${naY - 5}" fill="none" stroke="#000" stroke-width="1.6"/>`);
    S.push(`<text x="${naX}" y="${naY - 15} " text-anchor="middle" font-size="11" font-weight="bold">N</text>`);
  } else {
    // ===== FALLBACK: no usable side measurements =============================
    // Draw from the model's traced polygon (rotated so its north points UP) if it
    // gave one, else a rectangle from the form boundaries. This keeps the plan
    // useful when the sketch is too rough for measured reconstruction.
    const polyRaw: any[] = Array.isArray(drawing?.polygon) ? drawing.polygon.filter((p: any) => p && isFinite(p.x) && isFinite(p.y)) : [];
    const labels: any[] = Array.isArray(drawing?.labels) ? drawing.labels : [];
    const northClock = Number(drawing?.northDirection?.imageClockDeg) || 0;
    // Rotate points so the sketch's north (northClock° cw from image-up) points up.
    const rot = (-northClock * Math.PI) / 180;
    const cxp = 500, cyp = 500;
    const rotPt = (px: number, py: number) => {
      const dx = px - cxp, dy = py - cyp;
      return { x: cxp + dx * Math.cos(rot) - dy * Math.sin(rot), y: cyp + dx * Math.sin(rot) + dy * Math.cos(rot) };
    };
    const poly = polyRaw.map((p) => rotPt(p.x, p.y));

    if (poly.length >= 3) {
      const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
      const mnx = Math.min(...xs), mxx = Math.max(...xs), mny = Math.min(...ys), mxy = Math.max(...ys);
      const spanX = Math.max(1, mxx - mnx), spanY = Math.max(1, mxy - mny);
      const PAD = 40;
      const fit = Math.min((RW - 2 * PAD) / spanX, (RH - 2 * PAD) / spanY);
      const ox = RX + PAD + ((RW - 2 * PAD) - spanX * fit) / 2;
      const oy = RY + PAD + ((RH - 2 * PAD) - spanY * fit) / 2;
      const MX = (px: number) => ox + (px - mnx) * fit;
      const MY = (py: number) => oy + (py - mny) * fit;
      const ptsStr = poly.map((p) => `${MX(p.x).toFixed(1)},${MY(p.y).toFixed(1)}`).join(" ");
      S.push(`<polygon points="${ptsStr}" fill="url(#propHatch)" stroke="#000" stroke-width="2.6"/>`);
      for (const lb of labels) {
        if (!lb || !lb.text || !isFinite(lb.x) || !isFinite(lb.y)) continue;
        const rp = rotPt(lb.x, lb.y);
        const lx = Math.max(regL + 8, Math.min(regR - 8, MX(rp.x)));
        const ly = Math.max(regT + 8, Math.min(regB - 6, MY(rp.y)));
        S.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="12"${HALO}>${esc(lb.text)}</text>`);
      }
    } else {
      // Rectangle from form boundaries.
      const bx = RX + 46, by = RY + 40, bw = RW - 92, bh = RH - 92;
      S.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="url(#propHatch)" stroke="#000" stroke-width="2.6"/>`);
      const b = formBounds;
      if (b.north) S.push(`<text x="${bx + bw / 2}" y="${by - 8}" text-anchor="middle" font-size="12"${HALO}>${esc(b.north)}</text>`);
      if (b.south) S.push(`<text x="${bx + bw / 2}" y="${by + bh + 16}" text-anchor="middle" font-size="12"${HALO}>${esc(b.south)}</text>`);
      if (b.west) S.push(`<text x="${bx - 10}" y="${by + bh / 2}" font-size="12" transform="rotate(-90 ${bx - 10} ${by + bh / 2})" text-anchor="middle"${HALO}>${esc(b.west)}</text>`);
      if (b.east) S.push(`<text x="${bx + bw + 10}" y="${by + bh / 2}" font-size="12" transform="rotate(-90 ${bx + bw + 10} ${by + bh / 2})" text-anchor="middle"${HALO}>${esc(b.east)}</text>`);
    }
    // North arrow (up).
    const naX = regR - 24, naY = regT + 30;
    S.push(`<circle cx="${naX}" cy="${naY}" r="18" fill="#ffffff" stroke="#000" stroke-width="1.2"/>`);
    S.push(`<path d="M ${naX} ${naY + 12} L ${naX} ${naY - 12} M ${naX - 5} ${naY - 5} L ${naX} ${naY - 12} L ${naX + 5} ${naY - 5}" fill="none" stroke="#000" stroke-width="1.6"/>`);
    S.push(`<text x="${naX}" y="${naY - 15}" text-anchor="middle" font-size="11" font-weight="bold">N</text>`);
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
  // Index swatch shows the SAME cross-hatch used for the property under registration.
  S.push(`<rect x="${colX + 12}" y="${r2b + 8}" width="30" height="14" fill="url(#propHatch)" stroke="#000" stroke-width="1"/>`);
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
