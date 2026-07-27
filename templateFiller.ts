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

// Does this <w:p>…</w:p> block carry any VISIBLE content (text or an embedded
// image/object)? Whitespace-only text counts as empty.
function paragraphHasContent(p: string): boolean {
  let t = "";
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) t += m[1];
  if (t.replace(/\s+/g, "").length > 0) return true;
  return /<w:(drawing|pict|object)\b/.test(p);
}

// ---------------------------------------------------------------------------
// Remove COSMETIC manual line breaks from JUSTIFIED paragraphs.
//
// The templates were typed with <w:br/> at the wrap points of the ORIGINAL text
// ("...,Aged <Executant | Age> years", "occu: <...>, R/o | <Address>"). Those are
// not semantic breaks — they were only there to make the BLANK template look
// tidy. Once real names and addresses of a different length are substituted, the
// break lands mid-line, and because the paragraph is justified (w:jc="both")
// Word stretches that now-short line to the full measure. The result is the
// blown-apart word spacing seen in the rendered deed:
//     occu:            Household,                 R/o
//     5748        9790        9052,              Cell
// Deleting the break lets the line reflow naturally and the gaps vanish.
//
// Strictly limited so nothing else moves:
//   • ONLY paragraphs explicitly justified (w:jc="both"). Centered blocks such as
//     the "SALE DEED / Market Value / Stamp of Rs." heading use breaks as real
//     line separators and never stretch — touching them would collapse three
//     centered lines into one.
//   • A break that starts a new numbered clause, an ALL-CAPS heading, or a
//     schedule/witness marker is STRUCTURAL and kept ("... except the Vendor/s.
//     | 8. The Vendor/s hereby covenants ...").
//   • A break at the very end of a paragraph is left alone.
//   • Only <w:br/> elements are dropped; no <w:rPr>, <w:pPr> or run text is
//     touched, so fonts, bold, size, colour, indents and margins are unchanged.
// ---------------------------------------------------------------------------

// Text following a break that means "a new block starts here", not "the line
// happened to end here".
const SEMANTIC_AFTER_BREAK =
  /^(\d+[.)]\s|[IVX]+[.)]\s|[A-Z][A-Z][A-Z ,.'’\-]{4,}|SCHEDULE|WITNESS|IN FAVOUR|AND WHEREAS|WHEREAS|THIS DEED|WE DECLARE|DECLARATION|SIGN\b)/;

export function unwrapJustifiedBreaks(filledXml: string): { xml: string; removed: number } {
  let removed = 0;
  const out = filledXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (para) => {
    // Only justified paragraphs stretch. Anything else is left exactly as-is.
    const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(para)?.[0] || "";
    if (!/<w:jc w:val="both"\s*\/>/.test(pPr)) return para;
    if (!/<w:br\b[^>]*\/>/.test(para)) return para;

    // Walk the paragraph's <w:t> / <w:br/> sequence so we can see the text that
    // FOLLOWS each break and judge whether the break carries structure.
    const tokRe = /<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:t\s*\/>|<w:br\b[^>]*\/>/g;
    const toks: { kind: "t" | "br"; raw: string; text: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = tokRe.exec(para))) {
      const raw = m[0];
      if (raw.startsWith("<w:br")) {
        toks.push({ kind: "br", raw, text: "", at: m.index });
      } else {
        const open = raw.match(/^<w:t\b[^>]*>/)![0];
        const inner = raw.endsWith("/>") ? "" : raw.slice(open.length, raw.length - "</w:t>".length);
        toks.push({ kind: "t", raw, text: decodeXml(inner), at: m.index });
      }
    }

    // Decide each break, and whether dropping it would weld two words together.
    // A manual break stood in for a space, so if neither side already carries
    // whitespace we must substitute one ("R/o" + "H.No.1" -> "R/o H.No.1").
    const drops = new Map<number, { raw: string; needsSpace: boolean }>();
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].kind !== "br") continue;
      let after = "";
      for (let j = i + 1; j < toks.length && toks[j].kind === "t"; j++) after += toks[j].text;
      const trimmed = after.replace(/^\s+/, "");
      if (!trimmed) continue;                           // trailing break: leave it
      if (SEMANTIC_AFTER_BREAK.test(trimmed)) continue;  // structural: keep it

      let before = "";
      for (let j = i - 1; j >= 0 && toks[j].kind === "t"; j--) before = toks[j].text + before;
      const needsSpace = before !== "" && after !== "" && !/\s$/.test(before) && !/^\s/.test(after);
      drops.set(toks[i].at, { raw: toks[i].raw, needsSpace });
    }
    if (!drops.size) return para;

    // Single left-to-right splice: replace each chosen <w:br/> with either
    // nothing or a space. Nothing else in the paragraph is rewritten.
    //
    // A <w:br/> sits INSIDE a <w:r>, alongside that run's <w:t> children, e.g.
    //   <w:r><w:rPr>...</w:rPr><w:br/><w:t>years (DOB: ...</w:t></w:r>
    // so the replacement must be a run-level CHILD, not a <w:r>. Emitting a
    // <w:r> here would nest runs — invalid OOXML that Word and docx-preview
    // silently drop, which welds the words together ("Aged 50years").
    let result = "";
    let cursor = 0;
    for (const [at, { raw, needsSpace }] of drops) {
      result += para.slice(cursor, at);
      // A bare <w:t> is a legal sibling of <w:br/> and inherits the enclosing
      // run's <w:rPr>, so the space matches the surrounding text exactly.
      if (needsSpace) result += '<w:t xml:space="preserve"> </w:t>';
      removed++;
      cursor = at + raw.length;
    }
    result += para.slice(cursor);
    return result;
  });
  return { xml: out, removed };
}

// Remove body paragraphs that our marker-removal EMPTIED, so the deed shows no
// blank line where a value was missing. Paragraphs map 1:1 between the original
// and filled XML (filling only edits <w:t> text and drops <w:br/>; it never adds
// or removes <w:p>), so a paragraph that HAD content in the original but is empty
// now was emptied by us. We deliberately DO NOT touch:
//   • paragraphs already empty in the template  -> preserves intentional spacing;
//   • a paragraph carrying <w:sectPr>            -> preserves page size/margins;
//   • ANY paragraph inside a table (<w:tbl>)     -> preserves table cell structure
//                                                   (a cell must keep ≥1 paragraph).
function collapseEmptiedParagraphs(originalXml: string, filledXml: string): string {
  const paraRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g;

  // Emptiness of each ORIGINAL paragraph, in document order.
  const origHadContent: boolean[] = [];
  let om: RegExpExecArray | null;
  while ((om = paraRe.exec(originalXml))) origHadContent.push(paragraphHasContent(om[0]));

  // Walk the filled XML, interleaving table boundaries so we can tell when a
  // paragraph is inside a table (and must be left alone).
  const tokenRe = /<w:tbl\b[^>]*>|<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g;
  let out = "";
  let last = 0;
  let idx = 0;
  let tblDepth = 0;
  let removed = 0;
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(filledXml))) {
    const tok = tm[0];
    if (/^<w:tbl\b/.test(tok)) {
      tblDepth++;
      continue;
    }
    if (tok === "</w:tbl>") {
      tblDepth = Math.max(0, tblDepth - 1);
      continue;
    }
    // A paragraph token.
    const hadContent = origHadContent[idx] ?? true;
    idx++;
    if (
      tblDepth === 0 &&
      hadContent &&
      !paragraphHasContent(tok) &&
      !/<w:sectPr\b/.test(tok)
    ) {
      out += filledXml.slice(last, tm.index); // keep everything before this para
      last = tm.index + tok.length; // skip the emptied paragraph
      removed++;
    }
  }
  out += filledXml.slice(last);
  return removed > 0 ? out : filledXml;
}

// ---- Static-label cleanup for value-less markers ----------------------------
// A deed template pairs each marker with a static label:
//   "Stamp of Rs.<Stamp of Rs/->", "occu: <Executant Occupation>",
//   "Cell No.<Executant Cell.No.>", ",Date: <Link Doct.Date>"
// When the marker has no value, splicing out ONLY the marker leaves the label
// dangling — the "Stamp of Rs.", "occu: ,", "Cell No. (", "Doct.No.,Date: ,"
// fragments visible in the rendered deed. So we also scan LEFT for that label,
// with hard guards so real content is never deleted:
//   • stop at the end of another marker's span -> never eat a FILLED-IN value
//     (e.g. "the S.R.O.<Sub Registrar><Sub Registrar Code>": the text before the
//     empty code marker is the resolved value "Sircilla" and must survive)
//   • stop at a clause delimiter (, ;), a sentence end (". "), a line break, a
//     paragraph edge, or a closing bracket
//   • the candidate must LOOK like a label: ends in a lead-in glyph, <= 6 words,
//     no digits — running deed prose fails this and is left untouched
//   • length caps: generous when the marker ENDS its line (the whole clause is
//     meaningless without its value, e.g. "Together with Vacant Land Tax No.__"),
//     tight mid-sentence, where only a field-name tail is dropped so that
//     "the open plot no.<Plot No.>, admeasuring" -> "the open plot, admeasuring"
// Anything these rules cannot classify confidently is LEFT AS-IS: a stray label
// is a far safer failure than silently deleting text from a legal document.
const LABEL_TERMINATOR = /[.:\-/([=]$/;
const FIELD_NAME_TAIL = /(?:^|[ \t])(?:no|nos|number|dt|date)\.?[ \t:]*$/i;

function looksLikeLabel(candidate: string): boolean {
  const t = candidate.split(BREAK_SENTINEL).join(" ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/\d/.test(t)) return false; // values carry digits, labels don't
  if (t.split(" ").length > 6) return false; // a long word run is prose
  return LABEL_TERMINATOR.test(t); // must read as a lead-in to a value
}

function scanLabelStart(
  V: string,
  ps: number,
  cap: number,
  allBounds: Set<number>,
  valueEnds: Set<number>,
  paraBounds: Set<number>
): { start: number; hitCap: boolean; atDelim: boolean; atValueEnd: boolean } {
  let i = ps;
  let steps = 0;
  while (i > 0 && steps < cap) {
    const ch = V[i - 1];
    if (ch === "," || ch === ";")
      return { start: i, hitCap: false, atDelim: true, atValueEnd: false };
    // Boundary sets are keyed by absolute offset and INCLUDE this marker's own
    // start (== ps), so the first iteration must skip them or the scan would
    // stop dead at ps and never inspect the label to its left.
    if (i !== ps) {
      // A filled-in value ends here -> hard stop, and a SAFE one to cut at.
      if (valueEnds.has(i)) return { start: i, hitCap: false, atDelim: false, atValueEnd: true };
      // Hard boundaries we must not cross, but which don't license clause removal.
      if (paraBounds.has(i) || allBounds.has(i)) break;
    }
    if (ch === "\n" || ch === ")") break;
    if (ch === " " && i >= 2 && /[.!?]/.test(V[i - 2])) break; // previous sentence ended
    // A <w:br/> may fall INSIDE the label Word fragmented ("Cell " | BR | "No."),
    // so step over the sentinel rather than stopping — looksLikeLabel() collapses
    // it to a space, and consuming it also removes the stray line break.
    i--;
    steps++;
  }
  return { start: i, hitCap: steps >= cap, atDelim: false, atValueEnd: false };
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

  // PASS 1 — locate every marker and resolve it, WITHOUT deciding removals yet.
  // The label-cleanup below must know where OTHER markers begin and end (so it
  // never deletes a neighbouring marker's filled-in value), which means we need
  // the full marker census before planning any splice.
  interface Found {
    index: number;
    tok: string;
    innerSpace: string;
    value: string | null;
  }
  const found: Found[] = [];
  let scan: RegExpExecArray | null;
  while ((scan = phRe.exec(V))) {
    const rawTok = scan[0];
    const rawInner = rawTok.slice(open.length, rawTok.length - close.length);
    // A <w:br/> may fall BETWEEN words ("Executant"|"Age" -> "Executant Age")
    // or MID-word ("Marke"|"t" -> "Market"), so try both joins and take the
    // first that resolves. Space-join is the common/intended case.
    const innerSpace = rawInner.split(BREAK_SENTINEL).join(" ");
    const innerJoin = rawInner.split(BREAK_SENTINEL).join("");
    let value = resolve(innerSpace);
    if (value == null && innerJoin !== innerSpace) value = resolve(innerJoin);
    found.push({ index: scan.index, tok: rawTok, innerSpace, value });
  }

  // Boundary sets used by the left-scan:
  //   allBounds  — every marker edge (never cross another marker)
  //   valueEnds  — end of a marker that WILL be filled (safe, hard stop)
  //   paraBounds — paragraph starts/ends in the virtual stream
  const allBounds = new Set<number>();
  const valueEnds = new Set<number>();
  for (const f of found) {
    allBounds.add(f.index);
    allBounds.add(f.index + f.tok.length);
    if (f.value != null) valueEnds.add(f.index + f.tok.length);
  }
  const paraBounds = new Set<number>();
  {
    // Recompute paragraph edges against the virtual stream by walking the same
    // node order used to build V.
    let pos = 0;
    for (const n of nodes) {
      if (n.type === "t") pos += n.text.length;
      else if (n.type === "br") pos += 1;
      else if (/<\/w:p>|<w:p\b/.test(n.raw)) paraBounds.add(pos);
    }
  }

  const plans: Plan[] = [];
  const unresolved = new Set<string>();
  // PASS 2 — plan each splice, now that every marker's position and fate is known.
  for (const f of found) {
    const { tok: rawTok, innerSpace, value } = f;
    if (value == null) {
      // No value for this marker. Per requirement, the finished deed must NOT
      // show any raw <bracket> placeholder — so we splice it OUT (empty value)
      // rather than leaving it visible — but we STILL report the label in
      // `unresolved` so the Verify step surfaces it as a discrepancy (and the
      // caller can flag the important ones).
      unresolved.add(open + innerSpace.replace(/\s+/g, " ").trim() + close);
      // Also swallow the whitespace/line-break the removed marker leaves behind,
      // so the deed has no blank line or double space where a value was missing
      // (the "unnecessary gaps" the user flagged). In priority order:
      //   • a trailing <w:br/>  (the marker's own line)  -> drop that blank line
      //   • else a leading <w:br/>                        -> drop that blank line
      //   • else "A <m> B" (space on both sides)          -> collapse to "A B"
      //   • else a line-leading marker's trailing space   -> drop the space
      // (A whole paragraph left empty is removed later by collapseEmptiedParagraphs.)
      let ps = f.index;
      let pe = f.index + rawTok.length;

      // (a) Drop the dangling STATIC LABEL that introduced this missing value,
      // so the deed shows no "Stamp of Rs." / "occu: ," / "Cell No. (" stub.
      // Is the marker the last thing on its line? Then the whole clause is
      // meaningless without the value and a generous cut is warranted.
      let after = pe;
      while (V[after] === " ") after++;
      const endsLine =
        after >= V.length ||
        V[after] === BREAK_SENTINEL ||
        V[after] === "\n" ||
        paraBounds.has(after);
      const cap = endsLine ? 60 : 24;
      const scanned = scanLabelStart(V, ps, cap, allBounds, valueEnds, paraBounds);
      const candidate = V.slice(scanned.start, ps);

      if (!scanned.hitCap && looksLikeLabel(candidate)) {
        // Full clause removal is safe when the clause is delimited (",Date: " ->
        // cut at the comma), when the value ended just before it (S.R.O. case),
        // or when the marker closes its line ("Together with Vacant Land Tax No.").
        if (scanned.atDelim || scanned.atValueEnd || endsLine) {
          ps = scanned.start;
        } else {
          // Mid-sentence: keep the prose, shave only the field-name tail so
          // "the open plot no.<Plot No.>, admeasuring" -> "the open plot, admeasuring".
          const tail = FIELD_NAME_TAIL.exec(candidate);
          if (tail) ps = scanned.start + tail.index;
        }
      }

      // (b) Then swallow the whitespace/line-break the removal leaves behind, so
      // there is no blank line or double space where a value was missing.
      //   • a trailing <w:br/>  (the marker's own line)  -> drop that blank line
      //   • else a leading <w:br/>                        -> drop that blank line
      //   • else "A <m> B" (space on both sides)          -> collapse to "A B"
      //   • else a line-leading marker's trailing space   -> drop the space
      // (A whole paragraph left empty is removed by collapseEmptiedParagraphs.)
      if (V[pe] === BREAK_SENTINEL) pe += 1;
      else if (ps > 0 && V[ps - 1] === BREAK_SENTINEL) ps -= 1;
      else if (V[pe] === " " && ps > 0 && V[ps - 1] === " ") pe += 1;
      else if (V[pe] === " " && (ps === 0 || V[ps - 1] === "\n")) pe += 1;

      // (c) A clause cut at its leading comma can leave ", ," or " ,." — absorb
      // the now-duplicated separator that follows the hole.
      if (ps > 0 && (V[ps - 1] === "," || V[ps - 1] === ";")) {
        let q = pe;
        while (V[q] === " ") q++;
        if (V[q] === "," || V[q] === ";") pe = q + 1;
      }
      plans.push({ start: ps, end: pe, value: "" });
    } else {
      plans.push({ start: f.index, end: f.index + rawTok.length, value });
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

  // Remove any body paragraph our marker-removal left completely empty (a blank
  // line where a value was missing) — but never touch table cells, section
  // properties, or paragraphs that were already blank in the template.
  const collapsed = collapseEmptiedParagraphs(xml, parts.join(""));

  // Now that real values are in place, drop the template's cosmetic line breaks
  // so justified paragraphs reflow instead of stretching short lines.
  const unwrapped = unwrapJustifiedBreaks(collapsed);
  const filledXml = unwrapped.xml;

  // Plain-text preview: join t-node text; <w:br/> => newline; paragraph => blank line.
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
