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
  BOOLEAN: "BOOLEAN" as const,
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
            found: { type: T.STRING, description: "'yes' if north was determined (from a drawn arrow/compass OR an explicit N/side label), else 'no'. When 'no', the plan assumes the sketch is already north-up." },
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
                  imageEdge: {
                    type: T.STRING,
                    description:
                      "Which edge of the SKETCH IMAGE ITSELF this side is drawn along — TOP, BOTTOM, LEFT, or RIGHT — read LITERALLY from the picture layout, ignoring compass reasoning entirely (e.g. 'this line is drawn across the top of the page'). Report this independently of `direction` above; it is used only to mechanically cross-check that your compass call is consistent with the north arrow you found separately, so a reasoning slip on one does not silently corrupt the drawing.",
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

// Schema for the boundary cross-check. Without it the audit returned free-form
// JSON that intermittently failed to parse (invalid `\'` escapes, unterminated
// values) — silently discarding a correct audit and falling back to a report
// that claimed "no discrepancies". Constraining the response makes the shape
// predictable and the parse reliable.
export const BOUNDARY_AUDIT_SCHEMA: any = {
  type: T.OBJECT,
  properties: {
    extractedFromSketch: {
      type: T.OBJECT,
      description: "What is actually written on the SKETCH — never copied from the form data.",
      properties: {
        east: { type: T.STRING },
        west: { type: T.STRING },
        north: { type: T.STRING },
        south: { type: T.STRING },
        dimensions: { type: T.STRING, description: "e.g. \"66' x 66'\"" },
        roadDetails: { type: T.STRING },
      },
    },
    discrepancies: {
      type: T.ARRAY,
      description: "One entry per real mismatch between the sketch and the form. Empty if they agree.",
      items: {
        type: T.OBJECT,
        properties: {
          direction: { type: T.STRING, description: "East | West | North | South | Dimensions | Survey No" },
          formDetail: { type: T.STRING, description: "Value from the registration form." },
          sketchDetail: { type: T.STRING, description: "Value read off the sketch." },
          severity: { type: T.STRING, description: "CRITICAL | WARNING | INFO" },
          description: { type: T.STRING, description: "Plain-English explanation." },
          descriptionTe: { type: T.STRING, description: "The same explanation in Telugu." },
        },
        required: ["direction", "formDetail", "sketchDetail", "severity", "description"],
      },
    },
    isMatch: { type: T.BOOLEAN, description: "true ONLY when discrepancies is empty." },
  },
  required: ["extractedFromSketch", "discrepancies", "isMatch"],
};

export const PLAN_EXTRACTION_PROMPT = `You are a meticulous land surveyor and town-planning draftsman digitising a hand-drawn Telangana property registration sketch.

Read the sketch and extract its content as STRUCTURED MEASUREMENTS — do NOT try to trace the exact drawn shape (hand sketches are not to scale). We will REDRAW the plot to scale from your measurements.

CRITICAL RULES:
- IGNORE anything struck-off, crossed-out, scribbled, or signature squiggles. Do NOT transcribe them.
- ORIENT TO TRUE NORTH. The final plan is ALWAYS drawn with North pointing UP, so every direction you report must be TRUE compass, not "top of the page":
    1. FIND THE NORTH ARROW / compass rose. Report which way its head points as degrees clockwise from image-up in drawing.northDirection.imageClockDeg (0=up, 90=right, 180=down, 270=left) and set found='yes'.
    2. If there is NO arrow but a side is explicitly labelled "N"/"North"/"ఉత్తరం" (or a road/abutter names a compass side), infer north from that label and still set found='yes' with your best imageClockDeg.
    3. Only if north truly cannot be determined, set imageClockDeg=0 and found='no' — then we assume the sketch is already north-up.
  Decide each side's compass direction USING this north, so NORTH is genuinely the northern edge even if it was drawn sideways or upside-down.
- For EACH boundary side of the plot, add an entry to drawing.plot.sides with:
    • direction  = the TRUE COMPASS side it lies on (NORTH / SOUTH / EAST / WEST), decided using the north arrow above;
    • imageEdge  = which edge of the IMAGE ITSELF (TOP / BOTTOM / LEFT / RIGHT) this side is drawn along — a plain literal observation of the picture's layout, made WITHOUT any compass reasoning (do this step first, before you even think about north, so it cannot be contaminated by your "direction" answer);
    • lengthLabel = the dimension written on that edge, verbatim, keeping feet/inch marks (e.g. 48'-3", 66', 19'-9");
    • lengthFeet  = that dimension in decimal feet (48'-3" -> 48.25, 66' -> 66, 19'-9" -> 19.75);
    • neighbour   = the abutter named outside that side (e.g. "HOUSE OF CHAKALI CHANDRAVVA"), else empty.
  Most plots have exactly 4 sides (NORTH, SOUTH, EAST, WEST). ALWAYS provide these sides with their directions (and lengths where written) — this measured, direction-tagged form is what lets us redraw the plot north-up; the polygon fallback below cannot be oriented reliably. If a bearing/angle is written on an edge, put it in bearingDeg (clockwise from North), else 0.
- READ VERTICAL/ROTATED DIMENSION TEXT DIGIT-BY-DIGIT. Side lengths running along a vertical (East/West) edge are almost always written rotated 90°, and a rotated "6" is easily misread as "9" (and vice versa) — this is the single most common transcription error on these sketches. Before finalising each digit, mentally rotate it back to upright and re-check it individually; do not pattern-match the whole rotated numeral at a glance.
- CROSS-CHECK YOUR SIDE LENGTHS AGAINST THE PRINTED AREA TABLE. If the sketch has a TOTAL AREA / total sq.yds or sq.ft figure printed in its table, compute width × height from the four sides you extracted and compare it to that printed area (1 sq.yd = 9 sq.ft). If your computed area does NOT reasonably match the printed area (e.g. within ~10%), you have very likely misread a rotated digit on one of the vertical sides — go back and re-read that side's numeral before answering, and prefer the side length that reconciles with the printed area over your first read.
- Set drawing.plot.shape to 'square' if all sides are about equal, 'rectangle' if opposite sides are equal, else 'trapezoid' or 'irregular'.
- For EVERY road bordering the plot, add drawing.roads with its side (NORTH/SOUTH/EAST/WEST), its label verbatim ("40' ROAD"), and widthFeet in decimal feet so we can draw it to scale (a 40' road must read wider than a 12' road).
- Put inner structures (TINSHED / R.C.C. / OPEN PLACE) in drawing.interiorStructures with real widthFeet/depthFeet if written (else 0) and a position keyword.
- Copy the title, the property-description sentence, and each party block (DONOR/S, DONEE/S, VENDOR/S, VENDEE/S) verbatim into parties[]. Fill the AREA/PLINTH/SCALE table values if written, else leave empty strings.
- Only if you truly cannot identify the sides, fall back to giving drawing.polygon (ordered corners, 0..1000 space) and drawing.labels — but note this traced shape is only used when a north arrow was found (found='yes'), because otherwise it cannot be oriented north-up. Prefer the direction-tagged sides above.

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

// Draws the north-arrow compass symbol (circle + arrow + "N" label) centred at
// (cx, cy), optionally rotated `rotationDeg` clockwise from pointing straight
// up. The plot geometry itself is always drawn north-up regardless of this —
// rotating just the SYMBOL is what a prompt like "rotate north symbol into 90
// degrees" is asking for (a stylistic/annotation change to the compass glyph,
// not a request to redraw the plot at an angle).
//
// `detected` reflects whether the AI actually found a north reference (arrow /
// compass rose / explicit "N" label) on the UPLOADED sketch itself
// (drawing.northDirection.found === 'yes'), as opposed to us silently
// defaulting to north-up with no evidence from the sketch. When it was NOT
// detected, the symbol is drawn muted/dashed with a "N?" label and a small
// "NOT DETECTED — ASSUMED" caption so the plan doesn't overstate confidence
// it doesn't have. This is purely a rendering cue; it never changes geometry.
function drawNorthArrow(S: string[], cx: number, cy: number, rotationDeg: number, detected: boolean = true): void {
  const ink = detected ? "#000" : "#8a8a8a";
  const dash = detected ? "" : ' stroke-dasharray="3,2"';
  S.push(`<circle cx="${cx}" cy="${cy}" r="18" fill="#ffffff" stroke="${ink}" stroke-width="1.2"${dash}/>`);
  const rot = rotationDeg ? ` transform="rotate(${rotationDeg} ${cx} ${cy})"` : "";
  S.push(`<g${rot}>`);
  S.push(`<path d="M ${cx} ${cy + 12} L ${cx} ${cy - 12} M ${cx - 5} ${cy - 5} L ${cx} ${cy - 12} L ${cx + 5} ${cy - 5}" fill="none" stroke="${ink}" stroke-width="1.6"${dash}/>`);
  S.push(`<text x="${cx}" y="${cy - 15}" text-anchor="middle" font-size="11" font-weight="bold" fill="${ink}">${detected ? "N" : "N?"}</text>`);
  S.push(`</g>`);
  if (!detected) {
    S.push(`<text x="${cx}" y="${cy + 30}" text-anchor="middle" font-size="7.5" fill="${ink}">NORTH NOT DETECTED</text>`);
    S.push(`<text x="${cx}" y="${cy + 39}" text-anchor="middle" font-size="7.5" fill="${ink}">IN SKETCH — ASSUMED</text>`);
  }
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
export function personLine(p: any): string {
  if (!p) return "";
  const bits: string[] = [];
  const nameRel = [p.name, p.relation].filter(Boolean).join(" ");
  if (nameRel) bits.push(nameRel);
  if (p.age) bits.push(`AGED ${p.age} YEARS`);
  if (p.occupation) bits.push(`OCCU: ${p.occupation}`);
  if (p.address) bits.push(`R/O ${p.address}`);
  return bits.join(", ").toUpperCase() + (bits.length ? "." : "");
}

// Build the standard proforma description sentence from the authoritative form
// fields (falls back gracefully when a field is blank, never fabricating data):
//   "THE <TYPE>, ADMEASURING A TOTAL AREA OF <sqYds> SQUARE YARDS EQUIVALENT TO
//    <sqMtrs> SQUARE METERS, IN SURVEY NO.<survey>, SITUATED AT NEAR H.NO.<hNo>
//    OF '<locality>' LOCALITY OF <village>, <mandal>"
export function buildPlanDescription(plan: any, prop: any): string {
  const structureType = (plan?.structureType || prop?.propertyType || "PROPERTY").toString().toUpperCase();
  const tbl = plan?.table || {};
  const stripUnit = (v: any) => String(v ?? "").replace(/\s*sq\.?\s*(yds?|yards?|mtrs?|meters?|metres?)\.?\s*$/i, "").trim();
  const sqYds = stripUnit(tbl.totalAreaSqYds || prop?.extentSqYards || "");
  const sqMtrsRaw = stripUnit(tbl.totalAreaSqMtrs || "");
  const sqMtrs = sqMtrsRaw || (sqYds && isFinite(parseFloat(sqYds)) ? (parseFloat(sqYds) * 0.83612736).toFixed(2) : "");

  const bits: string[] = [`THE ${structureType},`];
  if (sqYds) {
    bits.push(`ADMEASURING A TOTAL AREA OF ${sqYds} SQUARE YARDS`);
    if (sqMtrs) bits.push(`EQUIVALENT TO ${sqMtrs} SQUARE METERS,`);
    else bits[bits.length - 1] += ",";
  }
  if (prop?.surveyNo) bits.push(`IN SURVEY NO.${prop.surveyNo},`);
  if (prop?.hNo) bits.push(`SITUATED AT NEAR H.NO.${prop.hNo}`);
  else bits.push(`SITUATED AT`);
  if (prop?.locality) bits.push(`OF '${String(prop.locality).toUpperCase()}' LOCALITY OF`);
  const place = [prop?.village, prop?.mandal].filter(Boolean).join(", ");
  if (place) bits.push(`${String(place).toUpperCase()}.`);
  return bits.join(" ").replace(/\s+,/g, ",").toUpperCase();
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
export function normDir(s: any): "N" | "S" | "E" | "W" | "" {
  const t = String(s || "").trim().toUpperCase();
  if (!t) return "";
  if (t.startsWith("NORTH") || t === "N") return "N";
  if (t.startsWith("SOUTH") || t === "S") return "S";
  if (t.startsWith("EAST") || t === "E") return "E";
  if (t.startsWith("WEST") || t === "W") return "W";
  return "";
}

// Normalise a raw image-edge word ("TOP"/"BOTTOM"/"LEFT"/"RIGHT") to one of
// the four literal picture edges ("" if unrecognised/missing).
function normImageEdge(s: any): "TOP" | "BOTTOM" | "LEFT" | "RIGHT" | "" {
  const t = String(s || "").trim().toUpperCase();
  if (t.startsWith("TOP")) return "TOP";
  if (t.startsWith("BOTTOM")) return "BOTTOM";
  if (t.startsWith("LEFT")) return "LEFT";
  if (t.startsWith("RIGHT")) return "RIGHT";
  return "";
}

// Mechanically derive which COMPASS direction a given image edge corresponds
// to, using ONLY the detected north-arrow angle (imageClockDeg) — no AI
// reasoning involved. imageClockDeg is degrees clockwise from image-up that
// north points (0=up, 90=right, 180=down, 270=left); rounding to the nearest
// 90° gives which literal picture edge (TOP/RIGHT/BOTTOM/LEFT) is north, and
// the other three edges follow going clockwise from there.
function imageEdgeToCompass(edge: "TOP" | "BOTTOM" | "LEFT" | "RIGHT", northClockDeg: number): "N" | "S" | "E" | "W" {
  const order: ("TOP" | "RIGHT" | "BOTTOM" | "LEFT")[] = ["TOP", "RIGHT", "BOTTOM", "LEFT"];
  const compassOrder: ("N" | "E" | "S" | "W")[] = ["N", "E", "S", "W"];
  const steps = Math.round(((northClockDeg % 360) + 360) % 360 / 90) % 4; // how many quarter-turns CW north is from TOP
  const northEdgeIdx = steps; // e.g. steps=1 -> north arrow points to the RIGHT edge
  const edgeIdx = order.indexOf(edge);
  const offset = ((edgeIdx - northEdgeIdx) % 4 + 4) % 4; // how many quarter-turns CW this edge is from the north edge
  return compassOrder[offset];
}

// Cross-check each side's AI-reasoned compass `direction` against a SECOND,
// independent, purely mechanical derivation: the literal image edge it was
// drawn on (imageEdge — a raw layout observation, not a compass judgement)
// combined with the separately-detected north-arrow angle (imageClockDeg).
// These two signals come from different questions (one is "what did the AI
// reason the compass direction was", the other is "where in the picture is
// this line, mechanically rotated by the detected arrow") — so they act as an
// independent check on each other, the same way reconcileSidesWithPrintedArea
// cross-checks lengths against the printed area instead of trusting a single
// AI read. When they disagree and we HAVE a detected north reference to trust,
// the mechanical derivation wins — it cannot suffer the "mental rotation"
// reasoning slip that direction alone is prone to (e.g. calling the west edge
// "north" because it was drawn along the top of an unusually-oriented sketch).
// Returns how many sides were corrected (0 if none, or if there wasn't enough
// signal to check at all).
export function reconcileSideDirectionsWithNorthArrow(
  rawSides: any[],
  northClockDeg: number,
  northFound: boolean
): number {
  if (!northFound || !Array.isArray(rawSides) || !rawSides.length) return 0;
  let corrected = 0;
  for (const s of rawSides) {
    const edge = normImageEdge(s?.imageEdge);
    if (!edge) continue; // AI didn't report a literal edge for this side — nothing to cross-check
    const claimed = normDir(s?.direction);
    const mechanical = imageEdgeToCompass(edge, northClockDeg);
    if (claimed && claimed !== mechanical) {
      s.direction = mechanical;
      corrected++;
    } else if (!claimed) {
      s.direction = mechanical;
    }
  }
  return corrected;
}

export interface SideInfo {
  lengthFeet: number;
  label: string;
  neighbour: string;
  fromForm?: boolean; // neighbour text came from the FORM boundaries, not the sketch
}
export type ByDir = { N?: SideInfo; S?: SideInfo; E?: SideInfo; W?: SideInfo };
export interface Pt {
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
export function reconstructRectilinear(byDir: ByDir): { corners: Pt[] } | null {
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
export function closeTraverse(legs: { lengthFeet: number; bearingDeg: number }[]): Pt[] | null {
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

// Digit-swap candidates for a suspected rotated-digit misread (a rotated "6" is
// easily read as "9" and vice versa — the single most common vision-extraction
// error on these hand-drawn sketches, since vertical/East-West dimension text is
// conventionally written rotated 90°). Returns every number obtainable by
// flipping some non-empty subset of the 6/9 digits in n, excluding n itself.
function digitSwapCandidates(n: number): number[] {
  const s = String(Math.round(n));
  const positions: number[] = [];
  for (let i = 0; i < s.length; i++) if (s[i] === "6" || s[i] === "9") positions.push(i);
  if (!positions.length) return [];
  const out = new Set<number>();
  const total = 1 << positions.length;
  for (let mask = 1; mask < total; mask++) {
    const chars = s.split("");
    positions.forEach((pos, bit) => {
      if (mask & (1 << bit)) chars[pos] = chars[pos] === "6" ? "9" : "6";
    });
    const cand = Number(chars.join(""));
    if (cand > 0 && cand !== n) out.add(cand);
  }
  return Array.from(out);
}

// Cross-check the extracted side lengths against the sketch's own printed TOTAL
// AREA figure and repair a likely rotated-digit misread (6<->9) when the two
// disagree beyond a reasonable tolerance. The model reliably transcribes the
// printed area text even when it misreads an individual rotated dimension
// numeral, so this gives a deterministic way to catch (and fix) that specific,
// reproducible error class without depending on the vision model self-correcting
// via prompt instructions alone (confirmed those instructions alone do not work).
export function reconcileSidesWithPrintedArea(byDir: ByDir, table: any): void {
  const tbl = table || {};
  const areaYdsStr = String(tbl.totalAreaSqYds || "").replace(/[^\d.]/g, "");
  const areaMtrsStr = String(tbl.totalAreaSqMtrs || "").replace(/[^\d.]/g, "");
  let areaSqFt = 0;
  if (areaYdsStr && isFinite(parseFloat(areaYdsStr))) areaSqFt = parseFloat(areaYdsStr) * 9;
  else if (areaMtrsStr && isFinite(parseFloat(areaMtrsStr))) areaSqFt = parseFloat(areaMtrsStr) * 10.7639;
  if (!(areaSqFt > 0)) return; // no ground truth printed on this sketch to check against

  const dirs: ("N" | "S" | "E" | "W")[] = ["N", "S", "E", "W"];
  const impliedArea = () => {
    const N = byDir.N?.lengthFeet || 0,
      S = byDir.S?.lengthFeet || 0;
    const E = byDir.E?.lengthFeet || 0,
      W = byDir.W?.lengthFeet || 0;
    const top = N || S,
      bottom = S || N,
      right = E || W,
      left = W || E;
    if (!(top > 0) || !(right > 0)) return 0;
    const width = (top + bottom) / 2 || top;
    const height = (left + right) / 2 || right;
    return width * height;
  };
  const withinTolerance = (a: number, b: number) => a > 0 && b > 0 && Math.abs(a - b) / b <= 0.12;

  const currentArea = impliedArea();
  if (withinTolerance(currentArea, areaSqFt)) return; // already reconciles — nothing to fix

  // Search over every side's original length PLUS its digit-swap candidates.
  // Two opposite edges (e.g. both EAST and WEST) are commonly written rotated the
  // same way, so BOTH can carry the identical misread independently — a
  // single-side-at-a-time fix cannot reconcile that case since changing only one
  // side leaves the other still wrong. Prefer the reconciling combination that
  // changes the FEWEST sides, breaking ties by closeness to the printed area.
  const present = dirs.filter((d) => byDir[d] && byDir[d]!.lengthFeet > 0);
  if (!present.length) return;
  const options: { dir: "N" | "S" | "E" | "W"; value: number; changed: boolean }[][] = present.map((dir) => {
    const orig = byDir[dir]!.lengthFeet;
    const cands = digitSwapCandidates(orig);
    return [{ dir, value: orig, changed: false }, ...cands.map((c) => ({ dir, value: c, changed: true }))];
  });
  const origVals: Record<string, number> = {};
  present.forEach((d) => (origVals[d] = byDir[d]!.lengthFeet));

  let best: { assignment: Record<string, number>; changedCount: number; delta: number } | null = null;
  const walk = (idx: number, acc: Record<string, number>, changedCount: number) => {
    if (idx === options.length) {
      const vals = { ...origVals, ...acc };
      const N = vals.N || 0,
        Sv = vals.S || 0,
        E = vals.E || 0,
        Wv = vals.W || 0;
      const top = N || Sv,
        bottom = Sv || N,
        right = E || Wv,
        left = Wv || E;
      const area = top > 0 && right > 0 ? ((top + bottom) / 2 || top) * ((left + right) / 2 || right) : 0;
      if (withinTolerance(area, areaSqFt)) {
        const delta = Math.abs(area - areaSqFt);
        if (!best || changedCount < best.changedCount || (changedCount === best.changedCount && delta < best.delta)) {
          best = { assignment: { ...acc }, changedCount, delta };
        }
      }
      return;
    }
    for (const opt of options[idx]) {
      acc[opt.dir] = opt.value;
      walk(idx + 1, acc, changedCount + (opt.changed ? 1 : 0));
    }
  };
  walk(0, {}, 0);

  if (best && best.changedCount > 0) {
    for (const dir of present) {
      const v = best.assignment[dir];
      if (v !== origVals[dir]) {
        const side = byDir[dir]!;
        side.lengthFeet = v;
        side.label = `${Math.round(v)}'`;
      }
    }
  }
}

export interface RoadEdit {
  label: string;
  widthFeet: number;
}

export interface PlanEdits {
  title?: string;
  /** Boundary neighbour text overrides, per cardinal direction. OVERRIDES
   *  whatever the sketch itself showed on that side — this is what makes an
   *  instruction like "north side is now a 30 feet road" actually change the
   *  drawn plan instead of being silently dropped because the sketch already
   *  had text there. */
  boundaries?: { N?: string; S?: string; E?: string; W?: string };
  /** Road to draw (or replace) on a given side, parsed from phrases like
   *  "18' road on the south" or "north side is now a 30 feet road". Also
   *  OVERRIDES anything the sketch extraction found for that side. */
  roads?: { N?: RoadEdit; S?: RoadEdit; E?: RoadEdit; W?: RoadEdit };
  /** Hex colour for the property cross-hatch (e.g. from "shade the plot blue"). */
  propertyColor?: string;
  /** Fill colour for an interior structure whose label matches a keyword, e.g.
   *  "highlight RCC house in light green" -> { rcc: "#a9dfbf" }. */
  structureColors?: Record<string, string>;
  /** Degrees CLOCKWISE to rotate the drawn north-arrow symbol, from
   *  "rotate north symbol/arrow ... NN degrees". 0 = arrow points straight up. */
  northRotationDeg?: number;
  /** "change/replace measurement X as/to Y" pairs (also matches "24' road as
   *  40' road"), applied to any side length or road width equal to X (within a
   *  small tolerance) wherever it appears in the drawing. */
  dimensionRemap?: Array<{ from: number; to: number }>;
  /** Any remaining instruction the structured rules above could not parse. Kept
   *  for debugging/telemetry only — NOT drawn on the plan itself, since the
   *  plan is a real registration document and should never carry the raw
   *  free-text prompt as visible content. */
  note?: string;
}

export interface RenderInput {
  plan?: any | null; // extracted sketch JSON (may be null)
  details?: any | null; // consolidated registration form details
  /** Structured, deterministic edits parsed from the user's custom prompt. */
  edits?: PlanEdits | null;
}

// Common colour words → hex, so a prompt like "shade the plot green" maps to a
// concrete stroke colour for the deterministic renderer.
const COLOR_WORDS: Record<string, string> = {
  red: "#c0392b", blue: "#2563eb", green: "#1e8449", yellow: "#c9a227",
  orange: "#d35400", brown: "#8b5a2b", black: "#000000", grey: "#6b7280",
  gray: "#6b7280", purple: "#7e3ff2", pink: "#d81b8c", teal: "#0a4d4a",
};

// Light colour variants for "light green", "light blue" etc — a plain colour
// word maps to the bold COLOR_WORDS hex, but structure highlights read better
// pastel since they sit as a small fill inside the plot, not a hatch stroke.
const LIGHT_COLOR_WORDS: Record<string, string> = {
  red: "#f5b7b1", blue: "#aed6f1", green: "#a9dfbf", yellow: "#f9e79f",
  orange: "#f5cba7", brown: "#d7bfa9", grey: "#d5d8dc", gray: "#d5d8dc",
  purple: "#d7bde2", pink: "#f5b7cf", teal: "#a3d9d5",
};

// Turn a free-text plan prompt into deterministic edits the SVG renderer can
// apply. Recognises: an explicit title, per-direction boundary/road overrides,
// a property fill colour, per-structure highlight colours, a north-arrow
// rotation, and dimension remaps ("36' as 40'"). Called with an EMPTY/blank
// prompt string this returns {} — the caller (server.ts) only invokes this
// when there IS a non-empty prompt, and passes `edits: null` otherwise, which
// is what makes clearing the prompt box actually revert the plan to the plain
// sketch/form-derived drawing instead of reusing the last-applied edits.
export function parsePlanPrompt(prompt: string): PlanEdits {
  const p = (prompt || "").trim();
  if (!p) return {};
  const edits: PlanEdits = {};

  const titleM = p.match(/\btitle\s*[:=]\s*([^\n.;]+)/i);
  if (titleM) edits.title = titleM[1].trim();

  // North-arrow rotation, e.g. "rotate north symbol into 90 degrees",
  // "rotate the compass by 45°", "turn north arrow 180 degrees clockwise".
  const northRotM = p.match(/\b(?:rotate|turn)\b[^.\n]*?\b(?:north\s*(?:arrow|symbol|sign)?|compass)\b[^.\n]*?(-?\d+(?:\.\d+)?)\s*(?:degrees?|°|deg\b)/i)
    || p.match(/\b(?:north\s*(?:arrow|symbol|sign)?|compass)\b[^.\n]*?\brotat\w*\b[^.\n]*?(-?\d+(?:\.\d+)?)\s*(?:degrees?|°|deg\b)/i);
  if (northRotM) edits.northRotationDeg = parseFloat(northRotM[1]);

  // Dimension remaps, e.g. "change the measurement 36' as 40'", "replace 60'
  // with 65'", "24' road as 40' road". Each match becomes a {from,to} pair the
  // renderer applies to any side length / road width equal to `from`.
  const dimensionRemap: Array<{ from: number; to: number }> = [];
  const remapRe = /(\d+(?:\.\d+)?)\s*(?:'|feet|ft)[^.\n\d]{0,25}?\b(?:as|to|with|=|->|→)\b[^.\n\d]{0,15}?(\d+(?:\.\d+)?)\s*(?:'|feet|ft)/gi;
  let dm: RegExpExecArray | null;
  while ((dm = remapRe.exec(p))) {
    const from = parseFloat(dm[1]);
    const to = parseFloat(dm[2]);
    if (isFinite(from) && isFinite(to) && from !== to) dimensionRemap.push({ from, to });
  }
  if (dimensionRemap.length) edits.dimensionRemap = dimensionRemap;

  // Per-direction boundary/road phrases, e.g. "north side is 30 feet road",
  // "draw 18' road in south", "east boundary is X's land". These OVERRIDE
  // whatever the sketch itself showed on that side — that's what makes a
  // prompt actually change the drawn plan instead of being dropped because
  // the sketch already had text there.
  const boundaries: { N?: string; S?: string; E?: string; W?: string } = {};
  const roads: { N?: RoadEdit; S?: RoadEdit; E?: RoadEdit; W?: RoadEdit } = {};
  const feetRe = /(\d+(?:\.\d+)?)\s*(?:feet|ft|'|foot)/i;

  const dirRe = /\b(north|south|east|west)\b\s*(?:side|boundary|bounded by|:|is|=|-)\s*([^,.;\n]+)/gi;
  let bm: RegExpExecArray | null;
  while ((bm = dirRe.exec(p))) {
    const key = bm[1][0].toUpperCase() as "N" | "S" | "E" | "W";
    const val = bm[2].trim();
    if (!val) continue;
    if (/\broad\b/i.test(val)) {
      const wf = feetRe.exec(val);
      const widthFeet = wf ? parseFloat(wf[1]) : 0;
      const label = widthFeet > 0 ? `${widthFeet}' ROAD` : val.toUpperCase();
      roads[key] = { label, widthFeet };
      boundaries[key] = label;
    } else {
      boundaries[key] = val;
    }
  }
  // Also catch "draw/add/put/move/widen NN' road ... [in/to/at] the <dir>"
  // phrasing, which the direction-first regex above does not match.
  const roadFirstRe = /\b(?:draw|add|put|move|widen)\b[^.\n]*?(\d+(?:\.\d+)?)\s*(?:feet|ft|')\s*(?:wide\s+)?road[^.\n]*?\b(?:in|to|at|on)\s+(?:the\s+)?(north|south|east|west)/gi;
  let rm: RegExpExecArray | null;
  while ((rm = roadFirstRe.exec(p))) {
    const key = rm[2][0].toUpperCase() as "N" | "S" | "E" | "W";
    const wf = parseFloat(rm[1]);
    const label = `${wf}' ROAD`;
    roads[key] = { label, widthFeet: wf };
    boundaries[key] = label;
  }
  if (Object.keys(boundaries).length) edits.boundaries = boundaries;
  if (Object.keys(roads).length) edits.roads = roads;

  const colorM = p.match(/\b(?:plot|land|property|schedule)\b[^.\n]*?\b(red|blue|green|yellow|orange|brown|black|grey|gray|purple|pink|teal)\b/i)
    || p.match(/\b(red|blue|green|yellow|orange|brown|black|grey|gray|purple|pink|teal)\b[^.\n]*?\b(?:plot|land|property|hatch|shade)\b/i);
  if (colorM) edits.propertyColor = COLOR_WORDS[colorM[1].toLowerCase()];

  // Per-structure highlight, e.g. "highlight RCC house in light green",
  // "make the tinshed blue". Matches the keyword the interior-structure
  // labels use (RCC / TINSHED / OPEN) so renderRegistrationPlanSvg can look
  // up a fill colour by the same keyword when it draws each structure box.
  const structureColors: Record<string, string> = {};
  const structRe = /\b(rcc|r\.c\.c\.?|tinshed|tin\s*shed|house|building)\b[^.\n]*?\b(light\s+)?(red|blue|green|yellow|orange|brown|black|grey|gray|purple|pink|teal)\b/gi;
  let sm: RegExpExecArray | null;
  while ((sm = structRe.exec(p))) {
    const key = sm[1].toLowerCase().replace(/[.\s]/g, "").replace(/^r\.?c\.?c\.?$/i, "rcc");
    const light = !!sm[2];
    const colorWord = sm[3].toLowerCase();
    structureColors[key] = (light ? LIGHT_COLOR_WORDS : COLOR_WORDS)[colorWord] || COLOR_WORDS[colorWord];
  }
  if (Object.keys(structureColors).length) edits.structureColors = structureColors;

  // Whatever the user wrote is retained as a note so ANY instruction visibly
  // affects the output, even one the structured rules above did not capture.
  edits.note = p.replace(/\s+/g, " ").slice(0, 220);
  return edits;
}

// ---- main renderer ----------------------------------------------------------
export function renderRegistrationPlanSvg(input: RenderInput): string {
  const plan = input.plan || {};
  const d = input.details || {};
  const prop = d.property || {};
  const drawing = plan.drawing || {};
  const edits = input.edits || {};

  // Merge prompt-driven boundary overrides into the form boundaries BEFORE any
  // downstream boundary/description/drawing logic reads them, so a "north side is
  // 30 feet road" instruction flows through to the side labels and description.
  if (edits.boundaries && Object.keys(edits.boundaries).length) {
    const b = { ...(prop.boundaries || {}) };
    if (edits.boundaries.N) b.north = edits.boundaries.N;
    if (edits.boundaries.S) b.south = edits.boundaries.S;
    if (edits.boundaries.E) b.east = edits.boundaries.E;
    if (edits.boundaries.W) b.west = edits.boundaries.W;
    prop.boundaries = b;
  }
  // Colour for the property cross-hatch (default matches the original teal-grey).
  const hatchColor = edits.propertyColor || "#6b8b87";

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
      `<line x1="0" y1="0" x2="0" y2="10" stroke="${hatchColor}" stroke-width="0.6"/>` +
      `<line x1="0" y1="0" x2="10" y2="0" stroke="${hatchColor}" stroke-width="0.6"/>` +
      `</pattern>` +
      `</defs>`
  );
  S.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  // Double outer border (proforma look).
  S.push(`<rect x="${M}" y="${M}" width="${W - 2 * M}" height="${H - 2 * M}" fill="none" stroke="#000" stroke-width="2"/>`);
  S.push(`<rect x="${M + 5}" y="${M + 5}" width="${W - 2 * M - 10}" height="${H - 2 * M - 10}" fill="none" stroke="#000" stroke-width="0.8"/>`);

  let y = M + 46;

  // ---- Title ----
  const title = (edits.title || plan.title || "PLAN FOR REGISTRATION").toUpperCase();
  S.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="27" font-weight="bold">${esc(title)}</text>`);
  const titleW = title.length * 27 * 0.6;
  S.push(`<line x1="${W / 2 - titleW / 2}" y1="${y + 5}" x2="${W / 2 + titleW / 2}" y2="${y + 5}" stroke="#000" stroke-width="1.2"/>`);
  y += 30;

  // ---- Property description ----
  // Matches the reference "PLAN FOR REGISTRATION" proforma paragraph:
  //   "THE <TYPE>, ADMEASURING A TOTAL AREA OF <X> SQUARE YARDS EQUIVALENT TO
  //    <Y> SQUARE METERS, IN SURVEY NO.<N>, SITUATED AT NEAR H.NO.<H> OF
  //    '<LOCALITY>' LOCALITY OF <VILLAGE>, <MANDAL>"
  // Built deterministically from the form's authoritative fields; a sketch that
  // already carries this exact sentence verbatim (plan.propertyDescription) is
  // preferred as-is, so nothing legible on the sketch is ever overwritten.
  const desc = (plan.propertyDescription && plan.propertyDescription.trim()) || buildPlanDescription(plan, prop);
  for (const ln of wrap(desc, contentW, 16)) {
    S.push(`<text x="${contentX}" y="${y}" font-size="16">${esc(ln)}</text>`);
    y += 21;
  }
  y += 10;

  // NOTE: earlier versions drew the user's raw prompt text here as an italic
  // "As per instruction: ..." line. That made the free-text prompt itself
  // appear as permanent content on a real registration document (visible even
  // in the final exported deed), which is wrong on two counts: it is not
  // something a registration plan should ever show, and it gave the
  // impression the prompt "took effect" whether or not the structured edits
  // below actually changed anything. The prompt is now applied ONLY through
  // the structured edits (boundaries/roads/colours/rotation/dimension remap)
  // and is never rendered as literal text.

  // ---- Party paragraphs ----
  // The registration PLAN (unlike the deed body) always labels the parties
  // "EXECUTANT/S" and "CLAIMANT/S" regardless of transaction type — that is the
  // fixed proforma wording on the reference plan, distinct from the deed's
  // transaction-specific VENDOR/S-VENDEE/S, DONOR/S-DONEE/S, etc.
  const roles = { first: "EXECUTANT/S", second: "CLAIMANT/S" };
  const sellers: any[] = Array.isArray(d.executants) ? d.executants : [];
  const buyers: any[] = Array.isArray(d.claimants) ? d.claimants : [];

  const firstList =
    sellers.map(personLine).filter(Boolean);
  if (!firstList.length) {
    const fb = (plan.parties || []).find((p: any) => /vendor|donor|mortgagor|lessor|first|releasor|settlor/i.test(p.role))?.detail;
    if (fb) firstList.push(fb);
  }
  const secondList =
    buyers.map(personLine).filter(Boolean);
  if (!secondList.length) {
    const fb = (plan.parties || []).find((p: any) => /vendee|donee|mortgagee|lessee|second|releasee|settlee/i.test(p.role))?.detail;
    if (fb) secondList.push(fb);
  }

  // Render a party block: the role label prefixes the FIRST line, and when there
  // is more than one executant/claimant each person starts on its OWN line.
  const emitParty = (label: string, people: string[]) => {
    const list = people.filter(Boolean);
    if (!list.length) return;
    const labelTxt = `${label}: `;
    const labelW = labelTxt.length * 16 * 0.62;
    S.push(`<text x="${contentX}" y="${y}" font-size="16" font-weight="bold" text-decoration="underline">${esc(labelTxt)}</text>`);
    let firstPerson = true;
    for (const person of list) {
      const lines = wrap(person, firstPerson ? contentW - labelW : contentW, 16);
      lines.forEach((ln, i) => {
        if (!ln) return;
        const x = firstPerson && i === 0 ? contentX + labelW : contentX;
        S.push(`<text x="${x}" y="${y}" font-size="16">${esc(ln)}</text>`);
        y += 21;
      });
      firstPerson = false;
    }
    y += 8;
  };
  emitParty(roles.first, firstList);
  emitParty(roles.second, secondList);

  // ================= DRAWING (full width — reference proforma has no side
  // TOTAL AREA/PLINTH/SCALE/INDEX table; that area info now lives in the
  // description paragraph above, and the compass lives inside this region's
  // top-right corner exactly as the reference plan shows it). =================
  const rowTop = Math.max(y + 18, 300);
  const RX = contentX + 6; // drawing region (left)
  const RY = rowTop + 10;
  const RW = contentW - 12;
  // Fixed bottom block ("AREA UNDER REGN" checkbox, WITNESSESS. lines, both
  // signature blocks) needs ~188px below the drawing region — see bottomY's
  // construction further down. RH used to be a flat 460px regardless of how
  // much vertical room the page actually had left after the (variable-length)
  // description/party paragraphs above, which routinely left a visible band of
  // unused whitespace between the drawing and the signature block — i.e. the
  // plan looked shorter than a full A4 page instead of using it. Stretching RH
  // to fill whatever room remains (bounded so it can never overflow the page,
  // and never shrink below the old 460 floor for very long descriptions) makes
  // the drawing consistently fill the full A4 sheet.
  const BOTTOM_BLOCK_H = 188;
  const RH = Math.max(460, H - M - 5 - RY - BOTTOM_BLOCK_H);

  // A white halo under drawing text keeps marks legible over lines/hatching
  // (paint-order="stroke" draws the white stroke first, then the black fill).
  const HALO = ' fill="#000" stroke="#ffffff" stroke-width="2.6" paint-order="stroke"';

  // Whether the AI actually found a north reference (arrow/compass rose/label)
  // ON THE UPLOADED SKETCH ITSELF, and at what angle. Computed here (before the
  // side directions are gathered) because it feeds the mechanical direction
  // cross-check below AND styles the north-arrow SYMBOL further down, so both
  // uses share the exact same detection result.
  const northClock = Number(drawing?.northDirection?.imageClockDeg) || 0;
  const northFound = String(drawing?.northDirection?.found || "").toLowerCase() === "yes";

  // ---- Gather measurements -------------------------------------------------
  const rawSides: any[] = Array.isArray(drawing?.plot?.sides) ? drawing.plot.sides : [];
  // The AI's per-side `direction` is a REASONED compass call, made by mentally
  // rotating the sketch — the same class of error-prone step that misreads
  // rotated digits (see reconcileSidesWithPrintedArea above). Cross-check it
  // against a mechanical derivation from the literal image-edge each side sits
  // on (imageEdge) plus the independently-detected arrow angle, and let the
  // mechanical answer win on disagreement — this is the actual fix for what
  // was previously just "trust whatever direction the AI said" with no check.
  reconcileSideDirectionsWithNorthArrow(rawSides, northClock, northFound);
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
  // Cross-check the extracted side lengths against the sketch's own printed
  // TOTAL AREA figure and repair a likely rotated-digit misread (6<->9) before
  // this feeds into geometry reconstruction below — see reconcileSidesWithPrintedArea.
  reconcileSidesWithPrintedArea(byDir, plan.table);

  // Prompt-driven dimension remaps ("change the measurement 36' as 40'") OVERRIDE
  // whatever the sketch read for any side whose length matches `from` — applied
  // AFTER the printed-area reconciliation above so a deliberate user correction
  // always wins over the sketch's own (possibly still-wrong) reading.
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

  // Prompt-driven boundary edits OVERRIDE whatever the sketch (or form) showed
  // on that side — unlike the form fallback above, this is a deliberate
  // instruction from the user ("Apply Prompt" / "Apply & Re-generate"), so it
  // must actually change the drawn label, not just sit in a footnote. Without
  // this, an instruction like "north side is now a 30 feet road" was silently
  // discarded whenever the sketch already had ANY text on that side — which is
  // true for almost every real hand-drawn sketch.
  if (edits.boundaries) {
    (["N", "S", "E", "W"] as const).forEach((k) => {
      const ov = (edits.boundaries as any)?.[k];
      if (!ov) return;
      if (!byDir[k]) byDir[k] = { lengthFeet: 0, label: "", neighbour: "" };
      byDir[k]!.neighbour = ov;
      byDir[k]!.fromForm = false;
    });
  }

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
  // (northClock/northFound were computed earlier, above the side-gathering
  // loop, so the direction cross-check and the north-arrow SYMBOL below both
  // use the exact same detection result.)

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
    // Prompt-driven road edits OVERRIDE whatever the sketch showed on that
    // side (or add a road the sketch never had) — same reasoning as the
    // boundary override above: a deliberate "Apply Prompt" instruction must
    // visibly change the drawing, not just add a footnote.
    if (edits.roads) {
      (["N", "S", "E", "W"] as const).forEach((k) => {
        const ov = (edits.roads as any)?.[k];
        if (ov) roadBySide.set(k, { label: ov.label, widthFeet: ov.widthFeet || 0 });
      });
    }
    // Dimension remaps also apply to road widths ("24' road as 40' road"), so a
    // correction to a road's width takes effect even when the road came from
    // the sketch rather than an explicit edits.roads override above.
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
    type IB = { label: string; bx: number; by: number; bw: number; bh: number; boxed: boolean; open: boolean; tx: number; ty: number; fill: string };
    // A prompt like "highlight RCC house in light green" is matched against
    // each structure's own label by keyword (rcc / tinshed / house / building),
    // so the highlight lands on whichever structure the sketch actually has.
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
    const interiorBoxes: IB[] = [];
    for (const st of interiors) {
      const label = String(st?.label || "").trim();
      if (!label) continue;
      const open = /open|vacant|khali|ఖాళీ/i.test(label);
      const wF = isFinite(st?.widthFeet) && st.widthFeet > 0 ? st.widthFeet : 0;
      const dF = isFinite(st?.depthFeet) && st.depthFeet > 0 ? st.depthFeet : 0;
      const pos = String(st?.position || "center").toLowerCase();
      const fill = colorForLabel(label);
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
        interiorBoxes.push({ label, bx, by, bw, bh, boxed: !open, open, tx: bx + bw / 2, ty: by + bh / 2, fill });
      } else {
        interiorBoxes.push({ label, bx: ax, by: ay, bw: 0, bh: 0, boxed: false, open, tx: ax, ty: ay, fill });
      }
    }
    // Pass 1: boxes (built structures only — open areas stay hatched).
    for (const b of interiorBoxes) {
      if (b.boxed && b.bw > 0 && b.bh > 0) {
        S.push(`<rect x="${b.bx.toFixed(1)}" y="${b.by.toFixed(1)}" width="${b.bw.toFixed(1)}" height="${b.bh.toFixed(1)}" fill="${b.fill}" stroke="#000" stroke-width="1.4"/>`);
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

    // North arrow — plot is placed with whichever side the AI tagged NORTH on
    // top (see reconstructRectilinear); this reconstruction does NOT itself
    // verify that tag against the sketch's own detected arrow, so the SYMBOL's
    // detected/not-detected styling below is the only honest signal of whether
    // the sketch actually had a north reference to go on. The SYMBOL additionally
    // rotates by edits.northRotationDeg when the prompt asked for it (e.g.
    // "rotate north symbol into 90 degrees"), independent of the drawing.
    drawNorthArrow(S, regR - 24, regT + 30, edits.northRotationDeg || 0, northFound);
  } else {
    // ===== FALLBACK: no usable side measurements =============================
    // Draw from the model's traced polygon (rotated so its north points UP) if it
    // gave one, else a rectangle from the form boundaries. This keeps the plan
    // useful when the sketch is too rough for measured reconstruction.
    const polyRaw: any[] = Array.isArray(drawing?.polygon) ? drawing.polygon.filter((p: any) => p && isFinite(p.x) && isFinite(p.y)) : [];
    const labels: any[] = Array.isArray(drawing?.labels) ? drawing.labels : [];
    // A traced polygon can only be trusted to sit north-up if we KNOW where north
    // is (a north arrow was actually found). Without that reference, drawing the
    // raw traced shape reproduces whatever rotation the sketch was drawn at — the
    // "plan is not north-up" bug. So we only use the traced polygon when a north
    // arrow was found (and rotate it upright by that arrow); otherwise we fall
    // through to the boundary rectangle, which is north-up by construction.
    // (northFound/northClock are computed once, above, and shared with the
    // north-arrow SYMBOL's detected/not-detected styling.)
    // Rotate points so the sketch's north (northClock° cw from image-up) points up.
    const rot = (-northClock * Math.PI) / 180;
    const cxp = 500, cyp = 500;
    const rotPt = (px: number, py: number) => {
      const dx = px - cxp, dy = py - cyp;
      return { x: cxp + dx * Math.cos(rot) - dy * Math.sin(rot), y: cyp + dx * Math.sin(rot) + dy * Math.cos(rot) };
    };
    const poly = polyRaw.map((p) => rotPt(p.x, p.y));

    if (poly.length >= 3 && northFound) {
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
    // North arrow (up, rotated per edits.northRotationDeg if requested); styled
    // detected/not-detected per whether the sketch itself actually had a north
    // reference (northFound) — same flag used above for the sides path.
    drawNorthArrow(S, regR - 24, regT + 30, edits.northRotationDeg || 0, northFound);
  }

  // ================= BOTTOM BLOCK (reference proforma layout) =================
  // Left column: an empty "AREA UNDER REGN" checkbox, then "WITNESSESS." with
  // two numbered blank signature lines. Right column: "EXECUTANT/S SIGN/S" and
  // "CLAIMANT/S SIGN/S", each with a blank signature line. This replaces the
  // old side TOTAL AREA/PLINTH/SCALE/INDEX table, which the reference plan
  // does not carry — that area/scale information now lives in the description
  // paragraph above the drawing instead.
  const bottomY = RY + RH + 46;
  const rightColX = contentX + contentW * 0.58;

  // "AREA UNDER REGN" checkbox (small empty square + label, bottom-left).
  const chk = 16;
  S.push(`<rect x="${contentX}" y="${bottomY - chk + 3}" width="${chk}" height="${chk}" fill="none" stroke="#000" stroke-width="1.2"/>`);
  S.push(`<text x="${contentX + chk + 8}" y="${bottomY}" font-size="13" font-weight="bold">AREA UNDER REGN</text>`);

  // EXECUTANT/S SIGN/S (right column, aligned with the checkbox row).
  const sig = (x: number, yy: number, label: string) => {
    const w2 = label.length * 13 * 0.62;
    S.push(`<text x="${x}" y="${yy}" font-size="13" font-weight="bold">${esc(label)}</text>`);
    S.push(`<line x1="${x}" y1="${yy + 4}" x2="${x + w2}" y2="${yy + 4}" stroke="#000" stroke-width="0.8"/>`);
  };
  sig(rightColX, bottomY, `${roles.first} SIGN/S`);

  // WITNESSESS. + two numbered blank lines (left column).
  let sy = bottomY + 44;
  S.push(`<text x="${contentX}" y="${sy}" font-size="13" font-weight="bold" text-decoration="underline">WITNESSESS.</text>`);
  sy += 34;
  S.push(`<text x="${contentX + 6}" y="${sy}" font-size="13">1.</text>`);
  S.push(`<line x1="${contentX + 24}" y1="${sy + 2}" x2="${contentX + contentW * 0.42}" y2="${sy + 2}" stroke="#000" stroke-width="0.7"/>`);
  sy += 34;
  S.push(`<text x="${contentX + 6}" y="${sy}" font-size="13">2.</text>`);
  S.push(`<line x1="${contentX + 24}" y1="${sy + 2}" x2="${contentX + contentW * 0.42}" y2="${sy + 2}" stroke="#000" stroke-width="0.7"/>`);

  // CLAIMANT/S SIGN/S (right column, level with the witness lines).
  sig(rightColX, bottomY + 78, `${roles.second} SIGN/S`);

  S.push(`</svg>`);
  return S.join("\n");
}

export function renderPlanDataUrl(input: RenderInput): string {
  const svg = renderRegistrationPlanSvg(input);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
