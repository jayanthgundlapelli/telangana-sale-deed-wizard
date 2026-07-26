// templateFiller.ts
// -----------------------------------------------------------------------------
// IN-PLACE .docx template filler.
//
// Fills the consolidated registration facts INTO an uploaded Word (.docx)
// template while preserving the template's EXACT formatting — fonts, bold,
// sizes, colours, alignment, margins, page size, line spacing, headers, tables
// — because it edits ONLY the text inside <w:t> runs and never touches <w:rPr>
// (run formatting), <w:pPr> (paragraph/alignment) or <w:sectPr> (page/margins).
//
// It solves the classic "split run" problem: Word fragments a single logical
// placeholder such as "<Executant Age>" across several <w:t> nodes and manual
// line breaks (<w:br/>), e.g.  ...Aged &lt;Executant </w:t><w:br/><w:t>Age&gt;...
// We rebuild a virtual character stream across the whole document (with a
// sentinel char per <w:br/>), locate placeholders in that stream even when they
// span runs/breaks, then splice the replacement value into the first run that
// owns the placeholder — inheriting that run's formatting for the whole value —
// and drop any <w:br/> that fell *inside* the matched placeholder.
// -----------------------------------------------------------------------------

import JSZip from "jszip";

const BREAK_SENTINEL = ""; // one private-use char represents a <w:br/>

// ---- XML 1.0 legality --------------------------------------------------------
// Word refuses to open a .docx whose word/document.xml contains characters that
// are ILLEGAL in XML 1.0 — the classic "The Office Open XML file cannot be opened
// because there are problems with the contents … Location: /word/document.xml"
// error. OCR, Gemini output, and copy-paste routinely inject such chars (NUL,
// vertical tab 0x0B, form feed 0x0C, other C0/C1 controls, lone UTF-16
// surrogates, and the non-characters U+FFFE/U+FFFF). We strip them from any text
// before it is written into a run. Tab (0x09), LF (0x0A) and CR (0x0D) are legal
// and preserved; the <w:br/> sentinel is handled separately on the write path.
// Ref: XML 1.0 §2.2 Char production.
export function stripInvalidXmlChars(s: string): string {
  if (!s) return "";
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // C0 controls except TAB/LF/CR
    if (code < 0x20) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) out += s[i];
      continue;
    }
    // DEL + C1 control block (0x7F–0x9F) — invisible, frequently corrupt output.
    if (code >= 0x7f && code <= 0x9f) continue;
    // Non-characters.
    if (code === 0xfffe || code === 0xffff) continue;
    // Surrogates: keep only well-formed high+low pairs, drop lone ones.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      continue; // lone high surrogate -> drop
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // lone low surrogate -> drop
    out += s[i];
  }
  return out;
}

// ---- XML entity helpers -----------------------------------------------------
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&"); // must be last
}
function encodeXml(s: string): string {
  return stripInvalidXmlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Normalise a placeholder's inner label so keys match regardless of the stray
// whitespace and line breaks Word injects: "< Claimant  Age>" -> "claimant age".
function normKey(inner: string): string {
  return inner.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---- Node model -------------------------------------------------------------
type Node =
  | { type: "t"; open: string; text: string } // a <w:t ...>text</w:t>
  | { type: "br" } // a <w:br/>
  | { type: "raw"; raw: string }; // anything else, passed through verbatim

// Split the whole document.xml into an ordered list of t / br / raw nodes.
function tokenize(xml: string): Node[] {
  const nodes: Node[] = [];
  const re = /<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:t\s*\/>|<w:br\b[^>]*\/>|<w:br\b[^>]*><\/w:br>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m.index > last) nodes.push({ type: "raw", raw: xml.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("<w:br")) {
      nodes.push({ type: "br" });
    } else if (/^<w:t\s*\/>$/.test(tok)) {
      nodes.push({ type: "t", open: '<w:t xml:space="preserve">', text: "" });
    } else {
      const open = tok.match(/^<w:t\b[^>]*>/)![0];
      const inner = tok.slice(open.length, tok.length - "</w:t>".length);
      nodes.push({ type: "t", open, text: decodeXml(inner) });
    }
    last = re.lastIndex;
  }
  if (last < xml.length) nodes.push({ type: "raw", raw: xml.slice(last) });
  return nodes;
}

export interface FillResult {
  xml: string;
  /** Placeholders that were present but had no supplied value (reported to verify). */
  unresolved: string[];
  /** Count of placeholder occurrences actually replaced with a value. */
  replaced: number;
  /** Plain-text rendering of the filled body (for the on-screen preview). */
  text: string;
}

/**
 * Fill placeholders inside a raw document.xml string.
 *
 * @param xml       the word/document.xml contents
 * @param resolve   given a placeholder's inner label, returns the replacement
 *                  string, or `null` to LEAVE the placeholder untouched (and
 *                  report it as unresolved).
 * @param open      opening delimiter of a placeholder (default "<")
 * @param close     closing delimiter (default ">")
 */
export function fillDocumentXml(
  xml: string,
  resolve: (inner: string) => string | null,
  open = "<",
  close = ">"
): FillResult {
  const nodes = tokenize(xml);

  // Build the virtual stream + remember which node owns each char range.
  let V = "";
  const owners: { node: Extract<Node, { type: "t" | "br" }>; start: number; end: number }[] = [];
  for (const n of nodes) {
    if (n.type === "t") {
      const start = V.length;
      V += n.text;
      owners.push({ node: n, start, end: V.length });
    } else if (n.type === "br") {
      const start = V.length;
      V += BREAK_SENTINEL;
      owners.push({ node: n, start, end: V.length });
    }
  }

  // Find placeholders. [^<>] (or the configured delimiters) also matches the
  // break sentinel and newlines, so a placeholder split by <w:br/> still matches.
  const o = open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const c = close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const phRe = new RegExp(`${o}[^${o}${c}]{1,120}${c}`, "g");

  interface Plan {
    start: number;
    end: number;
    value: string;
  }
  const plans: Plan[] = [];
  const unresolved = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = phRe.exec(V))) {
    const rawTok = match[0];
    const rawInner = rawTok.slice(open.length, rawTok.length - close.length);
    // A <w:br/> may fall BETWEEN words ("Executant"|"Age" -> "Executant Age")
    // or MID-word ("Marke"|"t" -> "Market"), so try both joins and take the
    // first that resolves. Space-join is the common/intended case.
    const innerSpace = rawInner.split(BREAK_SENTINEL).join(" ");
    const innerJoin = rawInner.split(BREAK_SENTINEL).join("");
    let value = resolve(innerSpace);
    if (value == null && innerJoin !== innerSpace) value = resolve(innerJoin);
    if (value == null) {
      unresolved.add(open + innerSpace.replace(/\s+/g, " ").trim() + close);
    } else {
      plans.push({ start: match.index, end: match.index + rawTok.length, value });
    }
  }

  // Char-level apply. For each position: if it's the START of a plan, emit the
  // whole value into the owning node's buffer; positions inside a plan are
  // dropped; positions outside are kept. A <w:br/> is kept only if its sentinel
  // position was not consumed by a plan.
  const isInsidePlan = (i: number): Plan | null => {
    for (const p of plans) if (i >= p.start && i < p.end) return p;
    return null;
  };
  const isPlanStart = (i: number): Plan | null => {
    for (const p of plans) if (i === p.start) return p;
    return null;
  };

  const outBuf = new Map<Node, string>();
  const brKept = new Map<Node, boolean>();
  for (const own of owners) {
    if (own.node.type === "t") {
      let buf = "";
      for (let i = own.start; i < own.end; i++) {
        const ps = isPlanStart(i);
        if (ps) {
          buf += ps.value;
          continue;
        }
        if (isInsidePlan(i)) continue; // char consumed by a placeholder
        buf += V[i];
      }
      outBuf.set(own.node, buf);
    } else {
      // br: sentinel occupies [start, start+1)
      brKept.set(own.node, !isInsidePlan(own.start));
    }
  }

  // Re-serialise nodes in original order.
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.type === "raw") {
      parts.push(n.raw);
    } else if (n.type === "br") {
      if (brKept.get(n) !== false) parts.push("<w:br/>");
    } else {
      const txt = outBuf.get(n) ?? n.text;
      // Preserve empty <w:t/> nodes as empty (harmless); keep xml:space.
      const open2 = /xml:space=/.test(n.open) ? n.open : n.open.replace(/>$/, ' xml:space="preserve">');
      parts.push(`${open2}${encodeXml(txt)}</w:t>`);
    }
  }

  // Plain-text preview: join t-node text; <w:br/> => newline; paragraph => blank line.
  const filledXml = parts.join("");
  const text = xmlToPlainText(filledXml);

  return {
    xml: filledXml,
    unresolved: Array.from(unresolved),
    replaced: plans.length,
    text,
  };
}

// Render document.xml to readable plain text for the on-screen preview.
export function xmlToPlainText(xml: string): string {
  // Split into paragraphs, then within each collect <w:t> and <w:br/>.
  const paras = xml.split(/<w:p\b[^>]*>/).slice(1).map((chunk) => chunk.split("</w:p>")[0]);
  const lines: string[] = [];
  for (const p of paras) {
    let line = "";
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>|<w:tab\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p))) {
      if (m[0].startsWith("<w:br")) line += "\n";
      else if (m[0].startsWith("<w:tab")) line += "\t";
      else line += decodeXml(m[1]);
    }
    lines.push(line);
  }
  return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

// -----------------------------------------------------------------------------
// ANGLE-BRACKET field resolver for annotated Telangana deed templates.
//
// The template marks every fill point with a human-readable label between angle
// brackets: <Executant Name>, <Market of Value Rs./->, <Plot No.>, <East
// Boundary>, etc. This maps each NORMALISED label (lowercased, whitespace
// collapsed) to a value from the consolidated registration `details`, tolerating
// the stray spaces Word injects (e.g. "< Claimant Age>"). resolve(label) returns
// the value, or null when no data was supplied — null tells the filler to LEAVE
// the marker in place (surfaced to Re-Verify) so we never fabricate facts.
// -----------------------------------------------------------------------------
export function buildAngleFieldResolver(details: any): {
  resolve: (label: string) => string | null;
  knownLabels: Set<string>;
} {
  const d = details || {};
  const sellers: any[] = Array.isArray(d.executants) ? d.executants : [];
  const buyers: any[] = Array.isArray(d.claimants) ? d.claimants : [];
  const prop = d.property || {};
  const bounds = prop.boundaries || {};
  const link = d.linkDeed || {};

  const joinNames = (arr: any[]) => arr.map((x) => x?.name).filter(Boolean).join(", ");
  const joinAadhaar = (arr: any[]) => arr.map((x) => x?.aadhaar).filter(Boolean).join(", ");
  const joinAges = (arr: any[]) =>
    arr.map((x) => (x?.age ? String(x.age) : "")).filter(Boolean).join(", ");
  const joinDob = (arr: any[]) => arr.map((x) => x?.dob).filter(Boolean).join(", ");
  const joinAddr = (arr: any[]) => arr.map((x) => x?.address).filter(Boolean).join("; ");
  const joinRel = (arr: any[]) => arr.map((x) => x?.relation).filter(Boolean).join(", ");
  const joinOcc = (arr: any[]) => arr.map((x) => x?.occupation).filter(Boolean).join(", ");
  const joinCell = (arr: any[]) => arr.map((x) => x?.cellNo).filter(Boolean).join(", ");

  // Compute sq metres from sq yards when only yards were supplied.
  // 1 sq yard = 0.836127 sq metre.
  const yards = parseFloat(String(prop.extentSqYards || "").replace(/[^\d.]/g, ""));
  const sqMtrsComputed =
    prop.extentSqMtrs ||
    (isFinite(yards) && yards > 0 ? (yards * 0.836127).toFixed(2) : "");

  // Per-yard market value = total / yards, when both known.
  const totalVal = parseFloat(
    String(d.marketValue || prop.marketValueTotal || "").replace(/[^\d.]/g, "")
  );
  const perYard =
    prop.marketValuePerYard ||
    (isFinite(totalVal) && isFinite(yards) && yards > 0
      ? Math.round(totalVal / yards).toLocaleString("en-IN")
      : "");

  const raw: Record<string, string> = {
    "market of value rs./-": String(d.marketValue || prop.marketValueTotal || ""),
    "stamp of rs/-": String(d.stampsAmount || ""),
    "market value per yard/-": String(perYard || ""),

    "executant name": joinNames(sellers),
    "executant relation name": joinRel(sellers),
    "executant age": joinAges(sellers),
    "executant dob": joinDob(sellers),
    "executant occupation": joinOcc(sellers),
    "executant address": joinAddr(sellers),
    "executant adhar number": joinAadhaar(sellers),
    "executant cell.no.": joinCell(sellers),

    "claimant name": joinNames(buyers),
    "claimant relation name": joinRel(buyers),
    "claimant age": joinAges(buyers),
    "claimant dob": joinDob(buyers),
    "claimant occupation": joinOcc(buyers),
    "claimant address": joinAddr(buyers),
    "claimant adhar number": joinAadhaar(buyers),
    "claimant cell.no.": joinCell(buyers),

    "link doct.type": String(link.docType || link.type || "Sale Deed"),
    "link doct.no.": String(link.deedNumber || ""),
    "link doct.date": String(link.executionDate || ""),
    "sub registrar": String(link.village || link.subRegistrar || ""),
    "sub registrar code": String(link.subRegistrarCode || ""),

    "plot no.": String(prop.plotNo || ""),
    "extent in sq.yards": String(prop.extentSqYards || ""),
    "extent in sq.mtrs": String(sqMtrsComputed || ""),
    "survey no.": String(prop.surveyNo || ""),
    "near h.no.": String(prop.hNo || ""),
    locality: String(prop.locality || prop.village || ""),
    "village & mandal": [prop.village, prop.mandal].filter(Boolean).join(", "),
    district: String(prop.district || ""),
    "pin code": String(prop.pincode || ""),
    village: String(prop.village || ""),

    "east boundary": String(bounds.east || ""),
    "west boundary": String(bounds.west || ""),
    "north boundary": String(bounds.north || ""),
    "south boundary": String(bounds.south || ""),
  };

  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) map.set(norm(k), v);

  const knownLabels = new Set(map.keys());
  const resolve = (label: string): string | null => {
    const key = norm(label);
    if (!map.has(key)) return null; // unknown marker -> leave as-is, flag later
    const val = map.get(key)!;
    return val && val.trim().length ? val : null; // empty data -> leave marker
  };
  return { resolve, knownLabels };
}

/**
 * Fill an entire .docx (base64 or Buffer) in place and return the new .docx
 * Buffer plus reporting metadata. Only word/document.xml text is modified.
 */
export async function fillDocxTemplate(
  input: Buffer | string,
  resolve: (inner: string) => string | null,
  opts: { open?: string; close?: string } = {}
): Promise<FillResult & { buffer: Buffer }> {
  const buf =
    typeof input === "string"
      ? Buffer.from(input.replace(/^data:.*;base64,/, ""), "base64")
      : input;
  const zip = await JSZip.loadAsync(buf);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a valid .docx (missing word/document.xml).");
  const xml = await docFile.async("string");

  const result = fillDocumentXml(xml, resolve, opts.open ?? "<", opts.close ?? ">");

  zip.file("word/document.xml", result.xml);
  const outBuf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  return { ...result, buffer: outBuf };
}
