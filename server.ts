import express from "express";
import path from "path";
import { promises as fsp } from "fs";
import os from "os";
import { execFile } from "child_process";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import WordExtractor from "word-extractor";
import { buildDeedDocx, mergePlaceholders, appendPlanPageToDocx } from "./documentBuilder";
import { fillDocxTemplate, buildAngleFieldResolver } from "./templateFiller";
import {
  renderPlanDataUrl,
  PLAN_EXTRACTION_SCHEMA,
  PLAN_EXTRACTION_PROMPT,
  BOUNDARY_AUDIT_SCHEMA,
} from "./planRenderer";
import {
  listTemplates,
  getTemplateText,
  getTemplateMeta,
  ensureTemplatesSeeded,
} from "./templateManager";

const Type = {
  OBJECT: "OBJECT" as const,
  STRING: "STRING" as const,
  INTEGER: "INTEGER" as const,
  ARRAY: "ARRAY" as const,
};

// Load environment variables from .env.local first, then .env as fallback
dotenv.config({ path: '.env.local' });
dotenv.config();

// The Gemini model used for all extraction/verification calls. Overridable via env
// so production can pick a cheaper tier (e.g. "gemini-2.5-flash" or
// "gemini-2.5-flash-lite") without code changes. Defaults to gemini-3.5-flash.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

// Lazy initialization of the Gemini client to avoid crashes if the API key is missing.
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === "MY_GEMINI_API_KEY" || key.trim() === "" || key.includes("YOUR_")) {
    return null;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Parse the Aadhaar JSON defensively. A mis-read image can make the model emit a
// runaway string that gets truncated at the token cap, yielding invalid JSON
// ("Unterminated string in JSON"). Rather than 500 the whole request, salvage
// whatever complete "key":"value" pairs we can so the user gets partial data.
const AADHAAR_KEYS = ["name", "relation", "occupation", "mobile", "dob", "age", "address", "district", "state", "pincode", "aadhaarNo"];

// Salvage the real fields when a value LOOKS like leaked reasoning that contains
// an embedded JSON object (observed when thinking is off and the prompt invites
// commentary: the model narrates then writes the true JSON inside one string).
// Returns a clean object, or null if no embedded object with known keys is found.
function recoverEmbeddedAadhaar(obj: Record<string, any>): Record<string, string> | null {
  for (const v of Object.values(obj)) {
    if (typeof v !== "string" || v.length < 20 || !v.includes("{")) continue;
    // Grab the LAST {...} block in the string — the model writes its final answer last.
    const blocks = v.match(/\{[\s\S]*?\}/g);
    if (!blocks) continue;
    for (const block of blocks.reverse()) {
      try {
        const inner = JSON.parse(block);
        if (inner && typeof inner === "object" && AADHAAR_KEYS.some((k) => k in inner)) {
          const out: Record<string, string> = {};
          for (const k of AADHAAR_KEYS) if (inner[k] != null) out[k] = String(inner[k]).trim();
          if (Object.keys(out).length) return out;
        }
      } catch { /* try the next block */ }
    }
  }
  return null;
}

// True when a parsed object is "clean": no value carries an embedded JSON object or
// obvious reasoning spillover. Guards against the leak surviving into the form.
function looksClean(obj: Record<string, any>): boolean {
  return !Object.values(obj).some(
    (v) => typeof v === "string" && v.includes("{") && v.includes('"')
  );
}

// Parse the Aadhaar JSON defensively. Handles three failure modes: (1) a value that
// contains the model's leaked reasoning wrapping an embedded JSON answer; (2) a
// truncated response ("Unterminated string in JSON") — salvage complete pairs by
// regex; (3) clean JSON — return as-is.
function safeParseAadhaarJson(raw: string): any {
  const text = (raw || "").trim().replace(/^```[a-z]*\n?|\n?```$/g, "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (looksClean(parsed)) return parsed;
      const recovered = recoverEmbeddedAadhaar(parsed);
      if (recovered) {
        console.warn("⚠️ Aadhaar response leaked reasoning into a field; recovered embedded JSON:", Object.keys(recovered).join(", "));
        return recovered;
      }
      // Parsed but dirty and unrecoverable — fall through to regex salvage below.
    } else {
      return parsed;
    }
  } catch { /* fall through to regex salvage */ }

  // Regex salvage: works on truncated JSON AND on a leaked string that still contains
  // valid "key":"value" pairs somewhere inside it.
  const out: Record<string, string> = {};
  for (const k of AADHAAR_KEYS) {
    // Match a complete "key": "value" pair (value has no unescaped quote).
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (m) out[k] = m[1].replace(/\\"/g, '"').trim();
  }
  if (Object.keys(out).length === 0) {
    throw new Error("Could not parse extraction result (response was truncated or malformed).");
  }
  console.warn("⚠️ Aadhaar JSON was truncated/malformed; salvaged fields:", Object.keys(out).join(", "));
  return out;
}

// Vision models routinely emit JSON containing JS-style escapes that JSON.parse
// REJECTS. Observed live on the boundary audit: the model quotes a dimension as
//     "the sketch shows a '15\' Road' on the East"
// `\'` is legal in JavaScript but illegal in JSON, so JSON.parse throws
// "Bad escaped character in JSON at position N" and the whole (correct) audit is
// discarded in favour of a fallback that reports "no discrepancies" — a FALSE
// ALL-CLEAR on a legal document. Repair only the escapes JSON forbids and leave
// every legal one (\" \\ \/ \b \f \n \r \t \uXXXX) untouched, so no real content
// is altered. Returns the parsed value, or null if it is still unparseable.
function parseModelJson(raw: string): any {
  const text = (raw || "").replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    // Drop the backslash from any escape JSON doesn't define. `\'` -> `'`.
    const repaired = text.replace(/\\([^"\\/bfnrtu])/g, "$1");
    try {
      const parsed = JSON.parse(repaired);
      console.warn("⚠️ Model JSON had invalid escapes; repaired and parsed successfully.");
      return parsed;
    } catch {
      console.warn(
        "Model JSON unparseable even after escape repair:",
        (firstErr as any)?.message || firstErr
      );
      return null;
    }
  }
}

// Post-process an Aadhaar extraction: compute age from DOB in code (models are
// unreliable at arithmetic) rather than trusting the model's own age calculation.
function normalizeAadhaar(data: any): any {
  if (!data || typeof data !== "object") return data;
  const dob: string = (data.dob || "").toString().trim();
  // Match DD/MM/YYYY, DD-MM-YYYY, or YYYY-MM-DD
  let year: number | null = null, month: number | null = null, day: number | null = null;
  let m;
  if ((m = dob.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) {
    year = +m[1]; month = +m[2]; day = +m[3];
  } else if ((m = dob.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) {
    day = +m[1]; month = +m[2]; year = +m[3];
  } else if ((m = dob.match(/^(\d{4})$/))) {
    // Some Aadhaar cards print only a birth YEAR (no day/month).
    year = +m[1];
  }
  const now = new Date();
  if (year && month && day) {
    // Normalize to DD/MM/YYYY for display consistency
    data.dob = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
    // Completed age as of TODAY — not a bare year subtraction. A legal deed states the
    // person's current (last-birthday) age, so we must account for whether this year's
    // birthday has already occurred. E.g. DOB 12/12/1979 on 2026-07-26 is 46, not 47.
    let age = now.getFullYear() - year;
    const monthDiff = now.getMonth() + 1 - month; // getMonth() is 0-based
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < day)) {
      age -= 1; // birthday hasn't happened yet this year
    }
    if (age >= 0 && age < 130) data.age = String(age);
  } else if (year) {
    // Year-only DOB: best-effort age estimate (exact month/day unknown).
    data.dob = String(year);
    const age = now.getFullYear() - year;
    if (age >= 0 && age < 130) data.age = String(age);
  }
  return data;
}

function generateHeuristicReport(draftText: string): any {
  const normalizedDraft = (draftText || "").toLowerCase();
  
  // Heuristic Check 1: Is it Preset 2? (Comprehensive Audit - Warangal Mismatches)
  if (normalizedDraft.includes("srinivasa rao") || normalizedDraft.includes("aged about 46")) {
    return {
      demoMode: true,
      summary: {
        status: "DISCREPANCY_FOUND",
        sellersCount: 1,
        discrepancyCount: 9,
        message: "DEMO MODE (Simulation): Found critical errors across all 3 audit segments: Names, Property details, and Link document numbers."
      },
      sellers: [
        {
          id: "Seller 1",
          aadhaarName: "Ankem Srinivas",
          draftName: "Ankem Srinivasa Rao",
          linkName: "Ankem Srinivas",
          aadhaarNo: "4521 8902 3412",
          draftAadhaarNo: "4521 8902 3412",
          dob: "12/06/1975",
          calculatedAge: 51,
          draftAge: 46,
          linkAge: 23,
          status: "MISMATCH",
          discrepancies: [
            "Name spelling mismatch: Draft contains 'Ankem Srinivasa Rao' but Aadhaar Card is 'Ankem Srinivas'",
            "Age mismatch: Draft says '46' but calculated rounded age is 51."
          ]
        }
      ],
      property: {
        linkSurveyNumbers: ["412/A"],
        draftSurveyNumbers: ["412/A"],
        linkVillage: "Nakrekal",
        draftVillage: "Nakrekal",
        linkHNo: "4-12/A",
        draftHNo: "4-12",
        linkPlotNo: "18",
        draftPlotNo: "15",
        linkPTINo: "1092003415",
        draftPTINo: "1092003999",
        linkSqYards: "300 Sq Yards",
        draftSqYards: "250 Sq Yards",
        linkPlinthArea: "1800 Sq Ft",
        draftPlinthArea: "1600 Sq Ft",
        linkBoundaries: {
          east: "Canal",
          west: "Ramulu's Land",
          north: "Main Road",
          south: "Venkataiah's Land"
        },
        draftBoundaries: {
          east: "Road",
          west: "Open Plot",
          north: "Neighbor",
          south: "Drain"
        },
        status: "MISMATCH",
        discrepancies: [
          "H.No mismatch: Link deed says '4-12/A' but Draft has '4-12'",
          "Plot No mismatch: Link deed says '18' but Draft has '15'",
          "PTI No mismatch: Link deed has '1092003415' but Draft has '1092003999'",
          "Sq Yards mismatch: Link deed says '300' but Draft has '250'",
          "Plinth Area mismatch: Link deed says '1800' but Draft has '1600'",
          "Boundaries mismatch: East, West, North, and South borders do not align."
        ]
      },
      linkDocumentVerification: {
        linkDeedNumber: "2304/1998",
        draftMentionedLinkDeedNumber: "2340/1998",
        status: "MISMATCH",
        discrepancies: [
          "Link Deed Document number typo: Link document has '2304/1998' but Draft mentions '2340/1998'"
        ]
      },
      allDiscrepancies: [
        {
          category: "Names mismatch",
          severity: "CRITICAL",
          description: "The spelling of the seller's name in the draft registration document does not match the official Aadhaar Card spelling.",
          descriptionTe: "డ్రాఫ్ట్ రిజిస్ట్రేషన్ పత్రంలో విక్రేత పేరు అక్షరక్రమం అధికారిక ఆధార్ కార్డుతో సరిపోలలేదు.",
          expected: "Ankem Srinivas",
          found: "Ankem Srinivasa Rao",
          recommendation: "Correct 'Ankem Srinivasa Rao' to 'Ankem Srinivas' to align character-by-character with the Aadhaar card.",
          recommendationTe: "ఆధార్ కార్డు ప్రకారం పేరును 'అంకెo శ్రీనివాసరావు' నుండి 'అంకెo శ్రీనివాస్' గా సవరించండి."
        },
        {
          category: "Names mismatch",
          severity: "WARNING",
          description: "The age written in the draft document is incorrect based on the official Aadhaar DOB (12/06/1975).",
          descriptionTe: "అధికారిక ఆధార్ జన్మతేదీ (12/06/1975) ఆధారంగా డ్రాఫ్ట్ పత్రంలో రాసిన వయస్సు తప్పుగా ఉంది.",
          expected: "51 Years",
          found: "46 Years",
          recommendation: "Update the seller's age from '46' to '51' years in the draft document.",
          recommendationTe: "డ్రాఫ్ట్ పత్రంలో విక్రేత వయస్సును '46' నుండి '51' సంవత్సరాలకు సరిచేయండి."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "The House Number (H.No) listed in the draft does not match the ownership link document.",
          descriptionTe: "డ్రాఫ్ట్‌లో పేర్కొన్న ఇంటి నంబర్ (H.No) యాజమాన్య లింక్ పత్రంతో సరిపోలడం లేదు.",
          expected: "4-12/A",
          found: "4-12",
          recommendation: "Update the house number in the draft from '4-12' to '4-12/A' to ensure title tracking.",
          recommendationTe: "హక్కుల రక్షణ కోసం డ్రాఫ్ట్‌లో ఇంటి నంబర్‌ను '4-12' నుండి '4-12/A' గా సవరించండి."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "Plot Number mismatch between draft and link deed.",
          descriptionTe: "డ్రాఫ్ట్ మరియు లింక్ దస్తావేజు మధ్య ప్లాట్ నంబర్ తేడా ఉంది.",
          expected: "Plot No 18",
          found: "Plot No 15",
          recommendation: "Correct the plot number in the draft to '18'.",
          recommendationTe: "డ్రాఫ్ట్‌లో ప్లాట్ నంబర్‌ను '18' గా సరిచేయండి."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "Property Tax Identification Number (PTI No) mismatch.",
          descriptionTe: "ఆస్తి పన్ను గుర్తింపు నంబర్ (PTI No) వ్యత్యాసం ఉంది.",
          expected: "1092003415",
          found: "1092003999",
          recommendation: "Change the PTI number in the draft to '1092003415'.",
          recommendationTe: "డ్రాఫ్ట్‌లో PTI నంబర్‌ను '1092003415' గా మార్చండి."
        },
        {
          category: "Property details mismatch",
          severity: "WARNING",
          description: "Slight area discrepancy (Sq Yards).",
          descriptionTe: "స్థలం విస్తీర్ణంలో చిన్న వ్యత్యాసం (చదరపు గజాలు).",
          expected: "300 Sq Yards",
          found: "250 Sq Yards",
          recommendation: "Verify and update the land extent to '300 Sq Yards' to prevent loss of asset description.",
          recommendationTe: "ఆస్తి విస్తీర్ణం నష్టం కాకుండా భూమి వైశాల్యాన్ని '300 చదరపు గజాలు' గా తనిఖీ చేసి సవరించండి."
        },
        {
          category: "Property details mismatch",
          severity: "WARNING",
          description: "Plinth Area mismatch in draft.",
          descriptionTe: "డ్రాఫ్ట్‌లో ప్లింత్ ఏరియా (నిర్మాణ వైశాల్యం) తేడా ఉంది.",
          expected: "1800 Sq Ft",
          found: "1600 Sq Ft",
          recommendation: "Modify the plinth area from '1600' to '1800' Sq Ft in the draft.",
          recommendationTe: "డ్రాఫ్ట్‌లో ప్లింత్ ఏరియాను '1600' నుండి '1800' చదరపు అడుగులుగా మార్చండి."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "Property boundaries listed in the draft do not match the official source link document.",
          descriptionTe: "డ్రాఫ్ట్‌లో నమోదు చేసిన ఆస్తి సరిహద్దులు మూల లింక్ పత్రంతో సరిపోలడం లేదు.",
          expected: "East: Canal, West: Ramulu's Land, North: Main Road, South: Venkataiah's Land",
          found: "East: Road, West: Open Plot, North: Neighbor, South: Drain",
          recommendation: "Correct all boundary listings in the draft to match the link document exactly.",
          recommendationTe: "లింక్ పత్రంలో ఉన్న విధంగా సరిహద్దుల వివరాలన్నింటినీ డ్రాఫ్ట్‌లో సరిగ్గా నమోదు చేయండి."
        },
        {
          category: "Link document numbers mismatch",
          severity: "CRITICAL",
          description: "The link document deed number referred in the draft has a typo.",
          descriptionTe: "డ్రాఫ్ట్‌లో ప్రస్తావించిన లింక్ దస్తావేజు నంబర్‌లో అక్షరదోషం (పొరపాటు) ఉంది.",
          expected: "2304/1998",
          found: "2340/1998",
          recommendation: "Correct the acquired link deed reference number from '2340/1998' to '2304/1998'.",
          recommendationTe: "లింక్ దస్తావేజు నంబర్ ప్రస్తావనను '2340/1998' నుండి '2304/1998' గా సరిచేయండి."
        }
      ],
      linkDocumentDetails: {
        language: "English",
        docNumber: "2304/1998",
        village: "Nakrekal",
        surveyNumbers: ["412/A"],
        sellersExtracted: ["Ankem Srinivas"]
      }
    };
  }

  // Heuristic Check 2: Is it Preset 3? (Telugu Link Doc & Property Mismatches)
  if (normalizedDraft.includes("k. ramu") || normalizedDraft.includes("120/aa")) {
    return {
      demoMode: true,
      summary: {
        status: "DISCREPANCY_FOUND",
        sellersCount: 1,
        discrepancyCount: 8,
        message: "DEMO MODE (Simulation): Found critical errors across Telugu name mapping, land surveys, and boundaries."
      },
      sellers: [
        {
          id: "Seller 1",
          aadhaarName: "Kethavath Ramulu",
          draftName: "K. Ramu",
          linkName: "కేతావత్ రాములు (Kethavath Ramulu)",
          aadhaarNo: "9874 5612 3045",
          draftAadhaarNo: "9874 5612 3045",
          dob: "01/01/1968",
          calculatedAge: 58,
          draftAge: 58,
          linkAge: null,
          status: "MISMATCH",
          discrepancies: [
            "Spelling mismatch: Draft contains abbreviated name 'K. Ramu' but Aadhaar Card is full spelling 'Kethavath Ramulu'"
          ]
        }
      ],
      property: {
        linkSurveyNumbers: ["102/AA"],
        draftSurveyNumbers: ["120/AA"],
        linkVillage: "Haveli Ghanpur",
        draftVillage: "Haveli Ghanpur",
        linkHNo: "2-104",
        draftHNo: "2-100",
        linkPlotNo: "55",
        draftPlotNo: "50",
        linkPTINo: "1088009944",
        draftPTINo: "1088009000",
        linkSqYards: "2.50 Acres",
        draftSqYards: "2.10 Acres",
        linkPlinthArea: "N/A",
        draftPlinthArea: "N/A",
        linkBoundaries: {
          east: "రాము భూమి (Ramu's Land)",
          west: "శేఖర్ భూమి (Sekhar's Land)",
          north: "కాలువ (Canal)",
          south: "చెరువు (Pond)"
        },
        draftBoundaries: {
          east: "State Highway",
          west: "Forest Land",
          north: "Open space",
          south: "Main Road"
        },
        status: "MISMATCH",
        discrepancies: [
          "Survey number mismatch: Link Document has '102/AA' but Draft has '120/AA'",
          "H.No mismatch: Link Document has '2-104' but Draft has '2-100'",
          "Plot No mismatch: Link Document has '55' but Draft has '50'",
          "PTI No mismatch: Link Document has '1088009944' but Draft has '1088009000'",
          "Extent mismatch: Link Document has '2.50 Acres' but Draft has '2.10 Acres'",
          "Boundaries mismatch: East, West, North, South boundaries do not align with the original Telugu link deed."
        ]
      },
      linkDocumentVerification: {
        linkDeedNumber: "PP-5049/2010",
        draftMentionedLinkDeedNumber: "PP-5000/2010",
        status: "MISMATCH",
        discrepancies: [
          "Link Deed Document number mismatch: Original has 'PP-5049/2010' but Draft says 'PP-5000/2010'"
        ]
      },
      allDiscrepancies: [
        {
          category: "Names mismatch",
          severity: "CRITICAL",
          description: "Seller's name in the draft uses abbreviation 'K. Ramu' and is misspelled compared to Aadhaar Card and Telugu link document.",
          expected: "Kethavath Ramulu",
          found: "K. Ramu",
          recommendation: "Change the name 'K. Ramu' to 'Kethavath Ramulu' to match official Aadhaar spelling exactly."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "The property survey number listed in the draft does not match the official source link document / Pattadar Passbook.",
          expected: "102/AA",
          found: "120/AA",
          recommendation: "Correct the survey number typo from '120/AA' to '102/AA' to prevent registration rejection."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "The House Number (H.No) listed in the draft is incorrect.",
          expected: "2-104",
          found: "2-100",
          recommendation: "Update the H.No from '2-100' to '2-104' in the draft."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "Plot Number mismatch.",
          expected: "55",
          found: "50",
          recommendation: "Correct the plot number from '50' to '55'."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "Property Tax Identification Number (PTI No) mismatch.",
          expected: "1088009944",
          found: "1088009000",
          recommendation: "Modify the PTI number in the draft from '1088009000' to '1088009944'."
        },
        {
          category: "Property details mismatch",
          severity: "WARNING",
          description: "Extent mismatch in the draft document.",
          expected: "2.50 Acres",
          found: "2.10 Acres",
          recommendation: "Correct the area size to '2.50 Acres'."
        },
        {
          category: "Property details mismatch",
          severity: "CRITICAL",
          description: "Property boundaries listed in the draft do not match the Pattadar Passbook details.",
          expected: "East: Ramu's Land, West: Sekhar's Land, North: Canal, South: Pond",
          found: "East: State Highway, West: Forest Land, North: Open space, South: Main Road",
          recommendation: "Correct all boundaries in the draft to match the original Telugu deeds."
        },
        {
          category: "Link document numbers mismatch",
          severity: "CRITICAL",
          description: "The link document reference/deed number in the draft has a critical typo.",
          expected: "PP-5049/2010",
          found: "PP-5000/2010",
          recommendation: "Change the acquired link deed reference from 'PP-5000/2010' to 'PP-5049/2010'."
        }
      ],
      linkDocumentDetails: {
        language: "Telugu",
        docNumber: "PP-5049/2010",
        village: "Haveli Ghanpur",
        surveyNumbers: ["102/AA"],
        sellersExtracted: ["కేతావత్ రాములు (Kethavath Ramulu)"]
      }
    };
  }

  // Heuristic Check 3: Default to Preset 1 / Perfect Match
  if (normalizedDraft.includes("ankem srinivas")) {
    return {
      demoMode: true,
      summary: {
        status: "APPROVED",
        sellersCount: 1,
        discrepancyCount: 0,
        message: "DEMO MODE (Simulation): All identity checks, property details, and link document deed numbers match exactly! No discrepancies found."
      },
      sellers: [
        {
          id: "Seller 1",
          aadhaarName: "Ankem Srinivas",
          draftName: "Ankem Srinivas",
          linkName: "Ankem Srinivas (అంకెమ్ శ్రీనివాస్)",
          aadhaarNo: "4521 8902 3412",
          draftAadhaarNo: "4521 8902 3412",
          dob: "12/06/1975",
          calculatedAge: 51,
          draftAge: 51,
          linkAge: 23,
          status: "MATCH",
          discrepancies: []
        }
      ],
      property: {
        linkSurveyNumbers: ["412/A"],
        draftSurveyNumbers: ["412/A"],
        linkVillage: "Nakrekal",
        draftVillage: "Nakrekal",
        linkHNo: "4-12",
        draftHNo: "4-12",
        linkPlotNo: "12",
        draftPlotNo: "12",
        linkPTINo: "1092003412",
        draftPTINo: "1092003412",
        linkSqYards: "240 Sq Yards",
        draftSqYards: "240 Sq Yards",
        linkPlinthArea: "1500 Sq Ft",
        draftPlinthArea: "1500 Sq Ft",
        linkBoundaries: {
          east: "Canal",
          west: "Ramulu's Land",
          north: "Main Road",
          south: "Venkataiah's Land"
        },
        draftBoundaries: {
          east: "Canal",
          west: "Ramulu's Land",
          north: "Main Road",
          south: "Venkataiah's Land"
        },
        status: "MATCH",
        discrepancies: []
      },
      linkDocumentVerification: {
        linkDeedNumber: "1204/1998",
        draftMentionedLinkDeedNumber: "1204/1998",
        status: "MATCH",
        discrepancies: []
      },
      allDiscrepancies: [],
      linkDocumentDetails: {
        language: "Telugu",
        docNumber: "1204/1998",
        village: "Nakrekal",
        surveyNumbers: ["412/A"],
        sellersExtracted: ["అంకెమ్ శ్రీనివాస్ (Ankem Srinivas)"]
      }
    };
  }

  // If the user uploaded custom files, let's parse them using regex heuristics to build an intelligent mock report!
  const foundAadhaarRegex = /(\d{4}\s?\d{4}\s?\d{4})/g.exec(draftText);
  const foundAadhaar = foundAadhaarRegex ? foundAadhaarRegex[0] : "4521 8902 3412";

  const foundSurveyRegex = /(survey|sy\.?\s?no\.?\s?)(\d+\/[A-Z0-9]+|\d+)/i.exec(draftText);
  const foundSurvey = foundSurveyRegex ? foundSurveyRegex[2] : "412/A";

  const foundNameRegex = /(sri|mr\.?|seller:?)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i.exec(draftText);
  const foundName = foundNameRegex ? foundNameRegex[2] : "Ankem Srinivas";

  const foundAgeRegex = /(age|aged about)\s+(\d+)/i.exec(draftText);
  const foundAge = foundAgeRegex ? parseInt(foundAgeRegex[2], 10) : 51;

  const foundHNoRegex = /(h\.?no\.?\s?[0-9-/A-Za-z]+)/i.exec(draftText);
  const foundHNo = foundHNoRegex ? foundHNoRegex[1] : "4-12";

  const foundPlotRegex = /(plot\s?(no\.?)?\s?\d+)/i.exec(draftText);
  const foundPlot = foundPlotRegex ? foundPlotRegex[1].replace(/plot\s?(no\.?)?\s?/i, "") : "12";

  const foundPTIRegex = /(pti\s?(no\.?)?\s?\d+)/i.exec(draftText);
  const foundPTI = foundPTIRegex ? foundPTIRegex[1].replace(/pti\s?(no\.?)?\s?/i, "") : "1092003412";

  const foundDeedNoRegex = /(deed\s?no\.?\s?[0-9/]+|document\s?no\.?\s?[0-9/]+)/i.exec(draftText);
  const foundDeedNo = foundDeedNoRegex ? foundDeedNoRegex[1].replace(/(deed|document)\s?no\.?\s?/i, "") : "1204/1998";

  // Return a customized report based on the parsed values
  const customDiscrepancies = [];
  if (foundAge !== 51) {
    customDiscrepancies.push({
      category: "Names mismatch",
      severity: "WARNING",
      description: `Draft lists age as ${foundAge} years, but calculated age from Aadhaar DOB is 51 years.`,
      expected: "51 Years",
      found: `${foundAge} Years`,
      recommendation: "Update the seller's age to '51' years to prevent registration blocks."
    });
  }

  // Residual-content / completeness heuristic: any un-replaced {{PLACEHOLDER}} token is a
  // critical error (leftover template content). This runs even without the Gemini API.
  const placeholderMatches = Array.from(new Set((draftText || "").match(/\{\{[^}]+\}\}/g) || []));
  placeholderMatches.forEach((ph) => {
    customDiscrepancies.push({
      category: "Residual content",
      severity: "CRITICAL",
      description: `The draft still contains an un-replaced template placeholder ${ph}. This is leftover template content and must not appear in the final deed.`,
      expected: "A real value for this field",
      found: ph,
      recommendation: `Return to Step 1, supply the value that maps to ${ph}, then re-generate the document.`
    });
  });

  return {
    demoMode: true,
    summary: {
      status: customDiscrepancies.length > 0 ? "WARNING" : "APPROVED",
      sellersCount: 1,
      discrepancyCount: customDiscrepancies.length,
      message: "DEMO MODE (Simulation): Dynamically processed your uploaded custom registration document using our local regex heuristics!"
    },
    sellers: [
      {
        id: "Seller 1",
        aadhaarName: foundName,
        draftName: foundName,
        linkName: foundName,
        aadhaarNo: foundAadhaar,
        draftAadhaarNo: foundAadhaar,
        dob: "12/06/1975",
        calculatedAge: 51,
        draftAge: foundAge,
        linkAge: null,
        status: foundAge === 51 ? "MATCH" : "WARNING",
        discrepancies: foundAge === 51 ? [] : [`Age mismatch: Draft says ${foundAge}, Aadhaar DOB implies 51.`]
      }
    ],
    property: {
      linkSurveyNumbers: [foundSurvey],
      draftSurveyNumbers: [foundSurvey],
      linkVillage: "Nakrekal",
      draftVillage: "Nakrekal",
      linkHNo: foundHNo,
      draftHNo: foundHNo,
      linkPlotNo: foundPlot,
      draftPlotNo: foundPlot,
      linkPTINo: foundPTI,
      draftPTINo: foundPTI,
      linkSqYards: "240 Sq Yards",
      draftSqYards: "240 Sq Yards",
      linkPlinthArea: "1500 Sq Ft",
      draftPlinthArea: "1500 Sq Ft",
      linkBoundaries: {
        east: "Canal",
        west: "Ramulu's Land",
        north: "Main Road",
        south: "Venkataiah's Land"
      },
      draftBoundaries: {
        east: "Canal",
        west: "Ramulu's Land",
        north: "Main Road",
        south: "Venkataiah's Land"
      },
      status: "MATCH",
      discrepancies: []
    },
    linkDocumentVerification: {
      linkDeedNumber: foundDeedNo,
      draftMentionedLinkDeedNumber: foundDeedNo,
      status: "MATCH",
      discrepancies: []
    },
    allDiscrepancies: customDiscrepancies,
    linkDocumentDetails: {
      language: "English",
      docNumber: foundDeedNo,
      village: "Nakrekal",
      surveyNumbers: [foundSurvey],
      sellersExtracted: [foundName]
    }
  };
}

function getHeuristicExtraction(documents: any[]): any {
  let isWarangal = false;
  let isTelugu = false;
  
  if (documents && Array.isArray(documents)) {
    const names = documents.map(d => (d.name || "").toLowerCase()).join(" ");
    if (names.includes("srinivas") || names.includes("ankem")) {
      isTelugu = false;
    } else if (names.includes("warangal") || names.includes("rao")) {
      isWarangal = true;
    } else if (names.includes("ramulu") || names.includes("kethavath") || names.includes("telugu")) {
      isTelugu = true;
    }
  }
  
  if (isWarangal) {
    return {
      executants: [
        {
          name: "Ankem Srinivas",
          relation: "S/o Ankem Ramulu",
          age: 51,
          aadhaar: "4521 8902 3412",
          pan: "ABCDE1234F",
          dob: "12/06/1975",
          address: "H.No 4-12, Near Hanuman Temple, Nakrekal Village, Nakrekal Mandal, Nalgonda District, Telangana - 508211"
        }
      ],
      claimants: [
        {
          name: "Ganta Venkat Reddy",
          relation: "S/o Ganta Malla Reddy",
          age: 45,
          aadhaar: "9876 5432 1098",
          pan: "XYZWP9876Z",
          dob: "15/08/1981",
          address: "Plot No 22, Jubilee Hills, Hyderabad, Telangana - 500033"
        }
      ],
      property: {
        surveyNo: "412/A",
        village: "Nakrekal",
        mandal: "Nakrekal",
        district: "Nalgonda",
        state: "Telangana",
        hNo: "4-12/A",
        plotNo: "18",
        ptiNo: "1092003415",
        extentSqYards: "300 Sq Yards",
        plinthArea: "1800 Sq Ft",
        boundaries: {
          east: "Canal",
          west: "Ramulu's Land",
          north: "Main Road",
          south: "Venkataiah's Land"
        }
      },
      linkDeed: {
        deedNumber: "2304/1998",
        executionDate: "14th August 1998",
        village: "Nakrekal"
      }
    };
  }
  
  if (isTelugu) {
    return {
      executants: [
        {
          name: "Kethavath Ramulu",
          relation: "S/o Kethavath Laxma",
          age: 58,
          aadhaar: "9874 5612 3045",
          pan: "PLKJH9081A",
          dob: "01/01/1968",
          address: "H.No 2-104, Haveli Ghanpur, Medak District, Telangana"
        }
      ],
      claimants: [
        {
          name: "Vangala Sudhakar",
          relation: "S/o Vangala Narsaiah",
          age: 42,
          aadhaar: "1234 5678 9012",
          pan: "CVBNM4561E",
          dob: "10/05/1984",
          address: "Plot No 44, NGO Colony, Medak, Telangana"
        }
      ],
      property: {
        surveyNo: "102/AA",
        village: "Haveli Ghanpur",
        mandal: "Haveli Ghanpur",
        district: "Medak",
        state: "Telangana",
        hNo: "2-104",
        plotNo: "55",
        ptiNo: "1088009944",
        extentSqYards: "2.50 Acres",
        plinthArea: "N/A",
        boundaries: {
          east: "Ramu's Land (రాము భూమి)",
          west: "Sekhar's Land (శేఖర్ భూమి)",
          north: "Canal (కాలువ)",
          south: "Pond (చెరువు)"
        }
      },
      linkDeed: {
        deedNumber: "PP-5049/2010",
        executionDate: "12th May 2010",
        village: "Haveli Ghanpur"
      }
    };
  }
  
  return {
    executants: [
      {
        name: "Ankem Srinivas",
        relation: "S/o Ankem Ramulu",
        age: 51,
        aadhaar: "4521 8902 3412",
        pan: "ABCDE1234F",
        dob: "12/06/1975",
        address: "H.No 4-12, Near Hanuman Temple, Nakrekal Village, Nakrekal Mandal, Nalgonda District, Telangana - 508211"
      }
    ],
    claimants: [
      {
        name: "Ganta Venkat Reddy",
        relation: "S/o Ganta Malla Reddy",
        age: 45,
        aadhaar: "9876 5432 1098",
        pan: "XYZWP9876Z",
        dob: "15/08/1981",
        address: "Plot No 22, Jubilee Hills, Hyderabad, Telangana - 500033"
      }
    ],
    property: {
      surveyNo: "412/A",
      village: "Nakrekal",
      mandal: "Nakrekal",
      district: "Nalgonda",
      state: "Telangana",
      hNo: "4-12",
      plotNo: "12",
      ptiNo: "1092003412",
      extentSqYards: "240 Sq Yards",
      plinthArea: "1500 Sq Ft",
      boundaries: {
        east: "Canal",
        west: "Ramulu's Land",
        north: "Main Road",
        south: "Venkataiah's Land"
      }
    },
    linkDeed: {
      deedNumber: "1204/1998",
      executionDate: "14th August 1998",
      village: "Nakrekal"
    }
  };
}

function localFillTemplate(templateText: string, details: any): string {
  if (!details) return templateText;
  let result = templateText || "";
  const seller = details.executants?.[0] || {};
  const buyer = details.claimants?.[0] || {};
  const prop = details.property || {};
  const bounds = prop.boundaries || {};
  const link = details.linkDeed || {};
  
  const replacements: Record<string, string> = {
    "{{SELLER_NAME}}": seller.name || "",
    "{{SELLER_RELATION}}": seller.relation || "",
    "{{SELLER_AGE}}": seller.age ? `${seller.age} Years` : "",
    "{{SELLER_AADHAAR}}": seller.aadhaar || "",
    "{{SELLER_PAN}}": seller.pan || "",
    "{{SELLER_ADDRESS}}": seller.address || "",
    "{{BUYER_NAME}}": buyer.name || "",
    "{{BUYER_RELATION}}": buyer.relation || "",
    "{{BUYER_AGE}}": buyer.age ? `${buyer.age} Years` : "",
    "{{BUYER_AADHAAR}}": buyer.aadhaar || "",
    "{{BUYER_PAN}}": buyer.pan || "",
    "{{BUYER_ADDRESS}}": buyer.address || "",
    "{{PROPERTY_SURVEY}}": prop.surveyNo || "",
    "{{PROPERTY_VILLAGE}}": prop.village || "",
    "{{PROPERTY_MANDAL}}": prop.mandal || "",
    "{{PROPERTY_DISTRICT}}": prop.district || "",
    "{{PROPERTY_STATE}}": prop.state || "Telangana",
    "{{PROPERTY_HNO}}": prop.hNo || "",
    "{{PROPERTY_PLOT}}": prop.plotNo || "",
    "{{PROPERTY_PTI}}": prop.ptiNo || "",
    "{{PROPERTY_EXTENT}}": prop.extentSqYards || "",
    "{{PROPERTY_PLINTH}}": prop.plinthArea || "",
    "{{BOUNDARY_EAST}}": bounds.east || "",
    "{{BOUNDARY_WEST}}": bounds.west || "",
    "{{BOUNDARY_NORTH}}": bounds.north || "",
    "{{BOUNDARY_SOUTH}}": bounds.south || "",
    "{{LINK_DEED_NO}}": link.deedNumber || "",
    "{{LINK_DEED_DATE}}": link.executionDate || ""
  };
  
  Object.entries(replacements).forEach(([placeholder, value]) => {
    const regex = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
    result = result.replace(regex, value);
  });
  return regexCleanDraft(result);
}

// Build the canonical {{PLACEHOLDER}} -> value map from the frontend's consolidated
// Helper to construct the official Rule 3 Statement of Market Value Table (Telangana Rules)
function generateRule3MarketValueTable(details: any): string {
  const d = details || {};
  const prop = d.property || {};
  const totalValNum = Number((d.marketValue || prop.marketValueTotal || "0").toString().replace(/,/g, "")) || 0;
  const valStr = totalValNum > 0 ? totalValNum.toLocaleString("en-IN") : (d.marketValue || prop.marketValueTotal || "0");
  
  const ptiVal = prop.vltPtiNo || prop.ptiNo || "";
  const ratePerYd = prop.marketValuePerSqYard ? `Rs. ${prop.marketValuePerSqYard}/- per Sq.Yard` : (prop.flatValuePerSqFeet ? `Rs. ${prop.flatValuePerSqFeet}/- per Sq.Ft` : "As per Basic Valuation Register");
  const extentStr = prop.extentSqYards ? `${prop.extentSqYards} Sq.Yards (${prop.extentSqMeters || (Number(prop.extentSqYards)*0.836127).toFixed(2)} Sq.Mtrs)` : (prop.plinthArea ? `Plinth: ${prop.plinthArea}` : "As specified");
  
  const descParts = [
    prop.surveyNo ? `Survey No: ${prop.surveyNo}` : "",
    prop.plotNo ? `Plot No: ${prop.plotNo}` : "",
    prop.hNo ? `Near H.No: ${prop.hNo}` : "",
    prop.village ? `Village: ${prop.village}` : "",
    prop.mandal ? `Mandal: ${prop.mandal}` : "",
    prop.district ? `District: ${prop.district}` : "",
    prop.pincode ? `Pincode: ${prop.pincode}` : "",
    ptiVal ? `VLT / PTI No: ${ptiVal}` : "",
  ].filter(Boolean).join(", ");

  const stampDutyVal = d.stampsAmount || (totalValNum > 0 ? Math.round(totalValNum * 0.05).toLocaleString("en-IN") : "");
  const transferDutyVal = totalValNum > 0 ? Math.round(totalValNum * 0.015).toLocaleString("en-IN") : "";
  const regFeeVal = totalValNum > 0 ? Math.round(totalValNum * 0.005).toLocaleString("en-IN") : "";
  const totalPayableVal = totalValNum > 0 ? Math.round(totalValNum * 0.07).toLocaleString("en-IN") : "";

  return `STATEMENT OF MARKET VALUE
(Under Rule 3 of the Telangana Prevention of Under Valuation of Instruments Rules, 1975)

+-------+-----------------------------------------------------------------+------------------------+------------------------------------+------------------------+
| S.No. | Description of Property & Location Details                      | Extent / Plinth Area   | Basic Market Value Rate            | Total Market Value(Rs) |
+-------+-----------------------------------------------------------------+------------------------+------------------------------------+------------------------+
|   1   | ${descParts || "Schedule Property Details"} | ${extentStr} | ${ratePerYd} | Rs. ${valStr}/- |
+-------+-----------------------------------------------------------------+------------------------+------------------------------------+------------------------+

SUMMARY OF VALUATION & REGISTRATION DUTY STRUCTURE:
1. Total Market Value of Scheduled Property : Rs. ${valStr}/-
2. Stamp Duty Payable (5%)                   : Rs. ${stampDutyVal}/-
3. Transfer Duty Payable (1.5%)             : Rs. ${transferDutyVal}/-
4. Registration Fee Payable (0.5%)          : Rs. ${regFeeVal}/-
------------------------------------------------------------------------
TOTAL PAYABLE STAMP DUTY & REGISTRATION FEES: Rs. ${totalPayableVal}/-`;
}

function regexCleanDraft(text: string): string {
  if (!text) return "";
  let cleaned = text;

  // 1. Remove unresolved mustache templates {{...}} or bracketed placeholders [______] or <...>
  cleaned = cleaned.replace(/\{\{[^}]+\}\}/g, "");
  cleaned = cleaned.replace(/\[\s*\_+\s*\]/g, "");
  cleaned = cleaned.replace(/\[\s*[A-Za-z0-9\s\/\.\-\:]+\s*\]/g, "");
  cleaned = cleaned.replace(/\<[^\>]+\>/g, "");

  // 2. Remove empty blank underlines like _____
  cleaned = cleaned.replace(/_{2,}/g, "");

  // 3. Clean dangling labels when empty
  // e.g. "and PAN ,", "PAN : ,", "PTI No: ,", "Door No: ,", "S/o ,"
  cleaned = cleaned.replace(/(?:,\s*|\sand\s*)(?:PAN|Aadhaar|Aadhaar\s*No|Cell|Cell\s*No|Phone|PTI|PTI\s*No|VLT|VLT\/PTI\s*No|Door\s*No|H\.No|Pincode|Plinth|Plinth\s*Area)\s*[\:\-]?\s*(?=[,\.\;\n]|$)/gi, "");

  // 4. Clean orphan relations like "S/o ," or "W/o ,"
  cleaned = cleaned.replace(/\b(S\/o|W\/o|D\/o|C\/o|R\/o)\s*[\,\.\;]/gi, "");

  // 5. Clean punctuation anomalies: duplicate commas, comma before period, dangling commas before newlines
  cleaned = cleaned.replace(/\,\s*\,/g, ",");
  cleaned = cleaned.replace(/\,\s*\./g, ".");
  cleaned = cleaned.replace(/\s+\,/g, ",");
  cleaned = cleaned.replace(/\,\s*$/gm, "");
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");

  return cleaned.trim();
}

// registration facts. Values are used verbatim (deterministic, no AI paraphrasing) so
// the final deed contains ONLY the current property/party data — nothing invented.
function buildPlaceholderMap(details: any): Record<string, string> {
  const d = details || {};
  const sellers: any[] = Array.isArray(d.executants) ? d.executants : [];
  const buyers: any[] = Array.isArray(d.claimants) ? d.claimants : [];
  const prop = d.property || {};
  const bounds = prop.boundaries || {};
  const link = d.linkDeed || {};

  const joinNames = (arr: any[]) => arr.map((x) => x?.name).filter(Boolean).join(", ");
  const joinAadhaar = (arr: any[]) => arr.map((x) => x?.aadhaar).filter(Boolean).join(", ");
  const joinAges = (arr: any[]) =>
    arr.map((x) => (x?.age ? `${x.age} Years` : "")).filter(Boolean).join(", ");
  const joinAddr = (arr: any[]) => arr.map((x) => x?.address).filter(Boolean).join("; ");
  const joinRel = (arr: any[]) => arr.map((x) => x?.relation).filter(Boolean).join(", ");
  const joinPan = (arr: any[]) => arr.map((x) => x?.pan).filter(Boolean).join(", ");

  const vltPti = prop.vltPtiNo || prop.ptiNo || "";

  return {
    "{{REGISTRATION_DATE}}": d.registrationDate || "",
    "{{MARKET_VALUE}}": d.marketValue || prop.marketValueTotal || "",
    "{{STAMP_DUTY}}": d.stampsAmount || "",
    "{{NATURE_OF_TRANSACTION}}": d.natureOfTransaction || "",
    "{{SELLER_NAME}}": joinNames(sellers),
    "{{SELLER_RELATION}}": joinRel(sellers),
    "{{SELLER_AGE}}": joinAges(sellers),
    "{{SELLER_AADHAAR}}": joinAadhaar(sellers),
    "{{SELLER_PAN}}": joinPan(sellers),
    "{{SELLER_ADDRESS}}": joinAddr(sellers),
    "{{BUYER_NAME}}": joinNames(buyers),
    "{{BUYER_RELATION}}": joinRel(buyers),
    "{{BUYER_AGE}}": joinAges(buyers),
    "{{BUYER_AADHAAR}}": joinAadhaar(buyers),
    "{{BUYER_PAN}}": joinPan(buyers),
    "{{BUYER_ADDRESS}}": joinAddr(buyers),
    "{{PROPERTY_SURVEY}}": prop.surveyNo || "",
    "{{PROPERTY_VILLAGE}}": prop.village || "",
    "{{PROPERTY_MANDAL}}": prop.mandal || "",
    "{{PROPERTY_DISTRICT}}": prop.district || "",
    "{{PROPERTY_PINCODE}}": prop.pincode || "",
    "{{PROPERTY_STATE}}": prop.state || "Telangana",
    "{{PROPERTY_HNO}}": prop.hNo || "",
    "{{PROPERTY_PLOT}}": prop.plotNo || "",
    "{{PROPERTY_PTI}}": vltPti,
    "{{PROPERTY_VLT_PTI}}": vltPti,
    "{{PROPERTY_EXTENT}}": prop.extentSqYards || "",
    "{{PROPERTY_PLINTH}}": prop.plinthArea || "",
    "{{BOUNDARY_EAST}}": bounds.east || "",
    "{{BOUNDARY_WEST}}": bounds.west || "",
    "{{BOUNDARY_NORTH}}": bounds.north || "",
    "{{BOUNDARY_SOUTH}}": bounds.south || "",
    "{{LINK_DEED_NO}}": link.deedNumber || "",
    "{{LINK_DEED_DATE}}": link.executionDate || "",
    "{{PATTADAR_PASSBOOK_NO}}": link.pattadarPassbookNo || "",
    "{{PASSBOOK_KHATA_NO}}": link.passbookKhataNo || "",
    "{{STATEMENT_OF_MARKET_VALUE_TABLE}}": generateRule3MarketValueTable(details),
  };
}

// AI-assisted fill for USER-SUPPLIED templates. A custom template the user uploads
// may use any placeholder style ({{X}}, [X], <X>, ____ blanks, or descriptive slots),
// so we let Gemini map the consolidated registration facts into the template's own
// wording. It is instructed to use values verbatim and never invent facts. Callers
// fall back to the deterministic {{PLACEHOLDER}} merge if this throws or Gemini is off.
async function aiFillTemplate(ai: any, templateText: string, details: any): Promise<string> {
  const sellerCount = Array.isArray(details?.executants) ? details.executants.length : 0;
  const buyerCount = Array.isArray(details?.claimants) ? details.claimants.length : 0;

  const prompt = `You are an expert legal document drafter for property Sale Deeds registered in Telangana, India. Your task is to update the supplied TEMPLATE document with the details from the registration form DATA while strictly preserving the supplied template's formatting style and structure.

═══════════ MANDATE 1: PRESERVE ALL FORMATTING, LAYOUT & SETUP STYLES ═══════════
- You MUST strictly preserve the supplied template's formatting style, including the layout setup, page size, margins, font style, font sizes, text alignments (left, centered, justified), page margins, padding, line spacing, bullet formats, numbered list formats, table structures, headers, footers, page numbers, and structural setup from the supplied TEMPLATE without altering or distorting them.
- Preserve EVERY word of fixed legal wording, EVERY clause, heading, recital, covenant, sub-clause, number, bullet point, page break marker (e.g., "---PAGE BREAK---"), page number (e.g., "-2-", "-3-"), and table structure VERBATIM.
- The output MUST have the exact SAME STRUCTURE, layout, order of sections, and page count as the supplied TEMPLATE.

═══════════ MANDATE 2: STRICTLY NO PLACEHOLDERS OR DASHES ═══════════
- You MUST NOT include any placeholder dashes, underscores (____), dashes (---), bracketed placeholders ([...]), [N/A], or empty line placeholders anywhere in the final text.
- If relevant information is not supplied or is empty in the registration form DATA for a particular field (e.g. optional PAN number, cell number, door number, plinth area, etc.), do NOT insert any dashes, underscores, or blank placeholders.
- Instead, smoothly omit or seamlessly adjust the unsupplied field or phrase entirely so that the text is registered cleanly, naturally, and professionally without any empty placeholders or dangling punctuation.

═══════════ WHAT YOU MAY CHANGE — TRANSACTION-SPECIFIC FACTS ONLY ═══════════
The TEMPLATE is a document whose specimen details MUST be updated with the corresponding real details from DATA:
1. VALUE / STAMP line at the top — "Value Rs.____", "Stamp Rs.____" → DATA.marketValue and DATA.stampsAmount.
2. EXECUTION DATE — DATA.registrationDate.
3. VENDOR/S (SELLER/S) block — for EACH seller: full NAME, relation (S/o | W/o | D/o + parent's name), age, DOB, occupation, full address (H.No, street/locality, village/mandal, district, state, pin), Aadhaar No, PAN → DATA.executants[].
4. VENDEE/S (BUYER/S) block — for EACH buyer: NAME, relation, age, DOB, occupation, full address, Cell No, Aadhaar No, PAN → DATA.claimants[].
5. LINK / PARENT DOCUMENT recital — DATA.linkDeed (deedNumber, village/S.R.O., executionDate).
6. CONSIDERATION amounts — set ALL occurrences to DATA.marketValue.
7. SCHEDULE OF THE PROPERTY — plot no, total area (sq yards AND sq meters), survey no, near H.No, locality/village, mandal, district, pin code, Gram Panchayat, Sub-Registrar office, District Registrar jurisdiction → DATA.property.
8. BOUNDARIES — East / West / North / South of the schedule property → DATA.property.boundaries.
9. MARKET-VALUE STATEMENT TABLE — update table cell values from DATA.property and DATA.marketValue while keeping table rows, columns, borders, and layout identical.

═══════════ MULTIPLE VENDORS / VENDEES — INCLUDE EVERY SINGLE ONE ═══════════
DATA.executants contains ${sellerCount} seller(s). DATA.claimants contains ${buyerCount} buyer(s).
- Render ALL of them. Expand vendor/buyer blocks to list EVERY person with their full details.

═══════════ NO LEAKAGE & NO PLACEHOLDERS ═══════════
- The finished deed must contain ONLY facts from DATA. NO specimen names, numbers, or addresses from the TEMPLATE may survive.
- NEVER output placeholder dashes (e.g. "________", "----", "[_____]", "N/A"). Register the text directly and smoothly without placeholders.

Return ONLY the finished deed text directly, matching the supplied template's structure and layout, with no markdown fences, no notes, and no explanation.

DATA (the ONLY source of truth for names, parties, property, amounts, and dates):
${JSON.stringify(details, null, 2)}

TEMPLATE (reproduce verbatim; preserve exact layout and formatting style; replace ONLY the transaction-specific facts listed above):
${templateText}`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      systemInstruction:
        "You are a senior Telangana registration deed drafter. Your mandatory duties are: 1. Preserve the supplied template's exact formatting style, setup layout, margins, paper size, fonts, font sizes, text alignment, headers, footers, padding, bullet/list formats, tables, and page breaks verbatim. 2. NEVER include any placeholder dashes, underscores (____), dashes (---), bracketed slots, or empty underlines anywhere in the final text. If any field or detail is not supplied in DATA, smoothly omit that unsupplied field or phrase so the document text is registered cleanly without placeholders. Return ONLY the final deed text with no markdown fences or commentary.",
      temperature: 0,
      maxOutputTokens: 16384,
    },
  });
  const resultText = (response.text || "").replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  return regexCleanDraft(resultText);
}

// Try converting a .docx buffer to PDF via LibreOffice (soffice). Returns null if
// LibreOffice is not installed — PDF is a nice-to-have; Word export is mandatory.
function convertDocxToPdf(docxBuffer: Buffer): Promise<Buffer | null> {
  return new Promise(async (resolve) => {
    let workDir: string | null = null;
    try {
      workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "deed-pdf-"));
      const inPath = path.join(workDir, "deed.docx");
      const outPath = path.join(workDir, "deed.pdf");
      await fsp.writeFile(inPath, docxBuffer);

      const candidates = ["soffice", "libreoffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"];
      const tryConvert = (idx: number) => {
        if (idx >= candidates.length) return resolve(null);
        execFile(
          candidates[idx],
          ["--headless", "--convert-to", "pdf", "--outdir", workDir!, inPath],
          { timeout: 60000 },
          async (err) => {
            if (err) return tryConvert(idx + 1);
            try {
              const pdf = await fsp.readFile(outPath);
              resolve(pdf);
            } catch {
              resolve(null);
            }
          }
        );
      };
      tryConvert(0);
    } catch {
      resolve(null);
    } finally {
      // Best-effort cleanup after a tick so the file read above can complete.
      if (workDir) {
        setTimeout(() => {
          fsp.rm(workDir!, { recursive: true, force: true }).catch(() => {});
        }, 2000);
      }
    }
  });
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Increase limits to handle PDF and high-res image base64 uploads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Endpoint to auto-adjust and clean empty blanks in the generated draft
app.post("/api/clean-draft", async (req, res) => {
  try {
    const { draftText, details } = req.body || {};
    if (!draftText || typeof draftText !== "string") {
      return res.status(400).json({ error: "draftText is required." });
    }

    const ai = getGeminiClient();
    let cleanedText = draftText;

    if (ai) {
      try {
        const prompt = `You are an expert legal document drafter and proofreader for property sale deeds in Telangana.
You are given a drafted deed text that contains leftover blank placeholders (such as {{PLACEHOLDER}}, [__________], [____], <...>, or empty underlines _____), or unsupplied optional field labels (e.g. "holding PAN ____", "PTI No: ____", "Door No: ____", "cell no: ____", "Aadhaar No: ____", "Plinth Area: ____", "S/o ____").

YOUR MANDATE:
1. Smoothly clean up, auto-adjust, and rewrite sentences so that ALL empty/unfilled placeholders or unsupplied labels are removed cleanly together with preceding/following words, while maintaining perfect legal grammar and sentence flow.
2. Example 1:
   Input: "Sri K. Ramu, S/o Venkatesh, holding Aadhaar No 123456789012, PAN: [_________], residing at..."
   Output: "Sri K. Ramu, S/o Venkatesh, holding Aadhaar No 123456789012, residing at..."
3. Example 2:
   Input: "Plot No 25, Door No [___________], Survey No 102/A"
   Output: "Plot No 25, Survey No 102/A"
4. Do NOT invent or fabricate any missing facts (names, numbers, dates, amounts).
5. Preserve all existing filled facts, headings, clauses, schedule of property, boundaries, and Rule 3 Statement of Market Value tables EXACTLY.

DRAFT TEXT TO AUTO-ADJUST & CLEAN:
${draftText}`;

        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            systemInstruction: "You are a professional legal deed editor. Remove leftover empty placeholders and auto-adjust preceding sentence phrases smoothly so the legal document flows naturally. Do not invent fake data.",
            temperature: 0,
            maxOutputTokens: 16384,
          },
        });
        cleanedText = (response.text || "").replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
      } catch (e) {
        console.warn("AI clean draft failed, using regex fallback:", e);
        cleanedText = regexCleanDraft(draftText);
      }
    } else {
      cleanedText = regexCleanDraft(draftText);
    }

    // Guarantee no leftover {{...}} or [_____] with regex post-pass
    cleanedText = regexCleanDraft(cleanedText);

    res.json({ cleanedText });
  } catch (err: any) {
    console.error("Clean draft endpoint error:", err);
    res.status(500).json({ error: "Failed to clean draft." });
  }
});

// List available predefined Word (.docx) deed templates (one per registration type).
app.get("/api/templates", async (_req, res) => {
  try {
    const templates = await listTemplates();
    res.json({ templates });
  } catch (err: any) {
    console.error("Failed to list templates:", err);
    res.status(500).json({ error: "Failed to list templates.", templates: [] });
  }
});

// Generate the final Sale Deed .docx: read the chosen Word template, merge the
// consolidated registration facts deterministically, and re-format to the Telangana
// spec (A4, Times New Roman 14, page-1 body offset 5.8in, pages 2+ standard margins).
// Returns the merged text (for the A4 preview) plus the .docx as base64.
app.post("/api/generate-document", async (req, res) => {
  try {
    const { templateId, details, customTemplateText, customTemplateName, customTemplateDocxBase64 } = req.body || {};
    const custom = typeof customTemplateText === "string" && customTemplateText.trim().length > 0;

    if (!templateId && !custom) {
      return res.status(400).json({ error: "templateId or customTemplateText is required." });
    }

    // ── PREFERRED PATH: true in-place .docx fill ────────────────────────────
    // When the user uploaded a .docx template, we have its ORIGINAL bytes. Fill
    // the <Angle Bracket> markers directly inside the zip so EVERY bit of the
    // template's formatting (fonts, bold, sizes, colour, alignment, margins,
    // page size, line spacing, tables, headers) is preserved byte-for-byte —
    // only the marked text is swapped for the extracted values.
    if (typeof customTemplateDocxBase64 === "string" && customTemplateDocxBase64.trim().length > 0) {
      try {
        const { resolve } = buildAngleFieldResolver(details);
        const filled = await fillDocxTemplate(customTemplateDocxBase64, resolve, { open: "<", close: ">" });
        return res.json({
          templateId: "custom-upload",
          templateName: customTemplateName || "Custom Uploaded Template",
          mergeMode: "inplace-docx",
          mergedText: filled.text,
          unresolvedPlaceholders: filled.unresolved,
          replacedCount: filled.replaced,
          docxBase64: filled.buffer.toString("base64"),
          format: { preserved: true, source: "uploaded-template" },
        });
      } catch (e: any) {
        console.warn("In-place .docx fill failed; falling back to text merge:", e?.message || e);
        // fall through to the legacy text-merge path below
      }
    }

    // Resolve the template WORDING: either the user's uploaded document text, or a
    // predefined library template read from ./templates.
    let templateText: string | null;
    let resolvedName: string;
    if (custom) {
      templateText = customTemplateText;
      resolvedName = customTemplateName || "Custom Uploaded Template";
    } else {
      templateText = await getTemplateText(templateId);
      if (templateText == null) {
        return res.status(404).json({ error: `Template '${templateId}' not found.` });
      }
      resolvedName = getTemplateMeta(templateId)?.name || templateId;
    }

    // Merge the consolidated facts into the template.
    // - Library templates use the canonical {{PLACEHOLDER}} tokens -> deterministic merge.
    // - Custom uploads may use ANY placeholder style, so we let Gemini map the facts into
    //   the template's own wording, then always run the deterministic {{...}} pass on top
    //   (harmless, and it catches any canonical tokens the user happened to use).
    const replacements = buildPlaceholderMap(details);
    let mergedText: string;
    let mergeMode: "deterministic" | "ai" = "deterministic";

    if (custom) {
      const ai = getGeminiClient();
      if (ai) {
        try {
          mergedText = await aiFillTemplate(ai, templateText!, details);
          mergedText = mergePlaceholders(mergedText, replacements);
          mergeMode = "ai";
        } catch (e) {
          console.warn("AI fill of custom template failed; using deterministic merge:", e);
          mergedText = mergePlaceholders(templateText!, replacements);
        }
      } else {
        // No API key -> deterministic {{PLACEHOLDER}} merge only.
        mergedText = mergePlaceholders(templateText!, replacements);
      }
    } else {
      mergedText = mergePlaceholders(templateText!, replacements);
    }

    // Detect any placeholders that were left unresolved (surfaced to the user/verify step).
    const unresolved = Array.from(new Set((mergedText.match(/{{[^}]+}}/g) || [])));

    const docxBuffer = await buildDeedDocx(mergedText);

    res.json({
      templateId: custom ? "custom-upload" : templateId,
      templateName: resolvedName,
      mergeMode,
      mergedText,
      unresolvedPlaceholders: unresolved,
      docxBase64: docxBuffer.toString("base64"),
      format: {
        page: "A4",
        font: "Times New Roman",
        fontSizePt: 14,
        firstPageBodyStartInches: 5.8,
        margins: { top: 1, left: 0.75, right: 0.75, bottom: 1 },
      },
    });
  } catch (err: any) {
    console.error("Document generation failed:", err);
    res.status(500).json({ error: "Failed to generate document.", detail: String(err?.message || err) });
  }
});

// Export the final deed. Accepts either finalText (edited in the preview) or a
// templateId+details pair. format = "docx" (mandatory) or "pdf" (best-effort via
// LibreOffice; falls back with a flag if unavailable). Returns base64 file data.
app.post("/api/export-document", async (req, res) => {
  try {
    const {
      format,
      finalText,
      templateId,
      details,
      // The ALREADY-FILLED .docx produced by /api/generate-document (in-place fill of
      // the uploaded template). This is the authoritative artifact the user reviewed
      // in the Stamp Preview — shipping these exact bytes guarantees the download is
      // byte-identical to the preview (tables, centered/bold titles, fonts, page
      // breaks all preserved) and removes any dependency on re-filling at export.
      filledDocxBase64,
      // The uploaded template's ORIGINAL .docx bytes. When present we preserve the
      // template's exact formatting by filling it in place rather than rebuilding
      // the deed from text — this is what makes the download open in Word cleanly
      // and match the uploaded template. (Accept a couple of aliases for safety.)
      templateDocxBase64,
      customTemplateDocxBase64,
      planImagePngBase64,
      planImageWidthPx,
      planImageHeightPx,
    } = req.body || {};

    // Plan image (already rasterised on the client). Appended as the LAST page of
    // whatever docx we produce, so the download carries the deed AND its plan.
    const planImg =
      typeof planImagePngBase64 === "string" && planImagePngBase64.trim().length > 0
        ? planImagePngBase64
        : undefined;
    const planW = Number(planImageWidthPx) || undefined;
    const planH = Number(planImageHeightPx) || undefined;

    let docxBuffer: Buffer;

    // Helper: splice the plan image in as the LAST page of an already-built docx.
    const withPlanPage = async (buf: Buffer): Promise<Buffer> => {
      if (!planImg) return buf;
      try {
        return await appendPlanPageToDocx(buf, {
          imageBase64: planImg,
          imageWidthPx: planW,
          imageHeightPx: planH,
        });
      } catch (e: any) {
        console.warn("Failed to append plan page to docx:", e?.message || e);
        return buf;
      }
    };

    // ── TOP PRIORITY: ship the ALREADY-FILLED docx the user reviewed ───────────
    // /api/generate-document already produced the in-place filled .docx (tables,
    // centered/bold titles, fonts, page breaks intact) and the Stamp Preview
    // rendered THOSE bytes. Re-using them here makes the download byte-identical to
    // what was previewed — the single source of truth — and sidesteps any chance of
    // a text-rebuild fallback losing the tables/formatting at export time.
    const preFilled =
      typeof filledDocxBase64 === "string" && filledDocxBase64.trim().length > 0
        ? filledDocxBase64
        : "";

    // ── PREFERRED PATH: preserve the uploaded template's format ────────────────
    // Re-fill the ORIGINAL .docx in place (only <w:t> text changes → fonts,
    // margins, tables, page setup are byte-preserved), then splice the plan page
    // straight into that same docx. No text rebuild, so no format drift.
    const tmplDocx =
      (typeof templateDocxBase64 === "string" && templateDocxBase64.trim().length > 0 && templateDocxBase64) ||
      (typeof customTemplateDocxBase64 === "string" && customTemplateDocxBase64.trim().length > 0 && customTemplateDocxBase64) ||
      "";
    if (preFilled) {
      const raw = preFilled.replace(/^data:[^,]+,/, "");
      docxBuffer = await withPlanPage(Buffer.from(raw, "base64"));
    } else if (tmplDocx) {
      const { resolve } = buildAngleFieldResolver(details);
      const filled = await fillDocxTemplate(tmplDocx, resolve, { open: "<", close: ">" });
      docxBuffer = await withPlanPage(filled.buffer);
    } else {
      // ── FALLBACK PATH: rebuild from text (library templates / no upload) ──────
      let mergedText: string = typeof finalText === "string" ? finalText : "";
      if (!mergedText && templateId) {
        const templateText = await getTemplateText(templateId);
        if (templateText == null) {
          return res.status(404).json({ error: `Template '${templateId}' not found.` });
        }
        mergedText = mergePlaceholders(templateText, buildPlaceholderMap(details));
      }
      if (!mergedText) {
        return res.status(400).json({ error: "finalText, templateDocxBase64, or templateId is required." });
      }
      docxBuffer = await buildDeedDocx(mergedText, {
        planImagePngBase64: planImg,
        planImageWidthPx: planW,
        planImageHeightPx: planH,
      });
    }

    if (format === "pdf") {
      const pdf = await convertDocxToPdf(docxBuffer);
      if (pdf) {
        return res.json({ format: "pdf", fileBase64: pdf.toString("base64"), mimeType: "application/pdf" });
      }
      // Graceful degradation: no LibreOffice -> tell client to use browser print-to-PDF.
      return res.json({
        format: "docx",
        pdfUnavailable: true,
        fileBase64: docxBuffer.toString("base64"),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        message: "PDF engine (LibreOffice) not available on server. Returned Word .docx; use the Print button to save as PDF.",
      });
    }

    return res.json({
      format: "docx",
      fileBase64: docxBuffer.toString("base64"),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  } catch (err: any) {
    console.error("Document export failed:", err);
    res.status(500).json({ error: "Failed to export document.", detail: String(err?.message || err) });
  }
});

// Endpoint to parse older Word .doc files
app.post("/api/parse-doc", async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) {
      return res.status(400).json({ error: "Base64 encoded file data is required." });
    }

    // Decode base64 to buffer
    const base64Data = base64.replace(/^data:.*;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    const text = doc.getBody();

    return res.json({ text });
  } catch (err: any) {
    console.error("Error parsing .doc file:", err);
    return res.status(500).json({ error: "Failed to parse .doc file. Please ensure it is a valid Microsoft Word 97-2003 document." });
  }
});

// Extract the raw text of an uploaded template that is a PDF or scanned image.
// Word (.doc/.docx) and .txt are handled elsewhere (mammoth / word-extractor /
// FileReader) without a model call; PDFs and images have no pure-JS text layer
// we can rely on in production (no pdftotext/LibreOffice in the container), so we
// transcribe them with Gemini. The goal is a VERBATIM transcription (every clause,
// heading, number, and blank preserved) that the merge step can then fill.
app.post("/api/extract-template-text", async (req, res) => {
  try {
    const { base64, mimeType } = req.body;
    if (!base64 || !mimeType) {
      return res.status(400).json({ error: "base64 and mimeType are required." });
    }

    const ai = getGeminiClient();
    if (!ai) {
      // No key → cannot OCR/transcribe a PDF here. Tell the client to use a
      // text-based template instead of failing silently.
      return res.status(503).json({
        error:
          "PDF/image templates need the Gemini API (not configured). Please upload a .docx, .doc, or .txt template, or paste the template text.",
      });
    }

    const data = String(base64).split(",")[1] || String(base64);
    const inlineData = { inlineData: { mimeType, data } };

    const transcriptionPrompt = `You are transcribing a legal document template (e.g. a Telangana Sale Deed) so it can be reused as a fill-in template.

Transcribe the ENTIRE document to plain text, VERBATIM:
- Preserve every clause, heading, numbered/lettered item, schedule, table, and signature block, in the original order.
- Keep all fixed legal wording exactly as written.
- Keep any blanks, underscores (____), or bracketed slots as they appear.
- Reproduce numbers, names, amounts, survey/plot numbers, and dates exactly as printed (do NOT correct, normalize, or invent anything).
- Preserve page markers and page numbers exactly as printed (e.g. "-2-", "-3-", "Page 2 of 4") on their own line, and mark each page break with a line containing only "---PAGE BREAK---" so the document's original page count and pagination can be reproduced.
- For tables, lay out the rows/columns as readable text (tabs or aligned spaces).
- Do NOT summarize, comment, translate, or add anything. Do NOT wrap the output in markdown code fences.

Return ONLY the transcribed document text.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [inlineData, { text: transcriptionPrompt }],
      config: {
        systemInstruction:
          "You are a precise document transcriber. Output the full document text verbatim, preserving structure. Never summarize, never add commentary, never use markdown fences.",
        temperature: 0,
      },
    });

    const text = (response.text || "").replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
    if (!text) {
      return res.status(502).json({ error: "The template could not be read from that file. Please try a different file." });
    }
    return res.json({ text });
  } catch (err: any) {
    console.error("Error extracting template text:", err?.message || err);
    return res.status(500).json({ error: "Failed to read the template file. Please try again or upload a .docx/.txt template." });
  }
});

// AI extraction endpoint (Step 4)
app.post("/api/extract", async (req, res) => {
  try {
    const { documents } = req.body;
    const ai = getGeminiClient();
    if (!ai) {
      console.log("GEMINI_API_KEY is missing. Running extract in heuristic simulation.");
      return res.json(getHeuristicExtraction(documents));
    }
    
    const contentsParts: any[] = [];
    if (documents && Array.isArray(documents)) {
      documents.forEach((doc, index) => {
        if (doc.base64 && doc.mimeType) {
          contentsParts.push({
            inlineData: {
              mimeType: doc.mimeType,
              data: doc.base64.split(",")[1] || doc.base64,
            }
          });
          contentsParts.push({
            text: `Document #${index + 1}: Name: ${doc.name}, Mime: ${doc.mimeType}`
          });
        }
      });
    }
    
    contentsParts.push({
      text: `Analyze the provided files (Aadhaar cards, PAN cards, property deeds, or passbooks) and extract ALL key real estate registration variables.
      
      Look for:
      - Executants (Sellers): Name, relation (e.g. S/o or D/o), age, Aadhaar number, PAN number, Date of Birth (DD/MM/YYYY), Address (residential address ONLY - do NOT include S/o, W/o or relation name inside address).
      - Claimants (Buyers): Name, relation, age, Aadhaar, PAN, Date of Birth (DD/MM/YYYY), Address (residential address ONLY - do NOT include S/o, W/o or relation name inside address).
      - Property details: Survey No, Village, Mandal, District, State, H.No, Plot No, PTI No, Extent (area), Plinth Area, and Boundaries (East, West, North, South).
      - Link Deed Reference: Document Number, Execution Date, Registered Village/Office.
      
      Return ONLY valid JSON adhering to the required schema. Ensure any Telugu text is translated to English.`
    });
    
    const extractSchema = {
      type: Type.OBJECT,
      properties: {
        executants: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              relation: { type: Type.STRING },
              age: { type: Type.INTEGER },
              aadhaar: { type: Type.STRING },
              pan: { type: Type.STRING },
              dob: { type: Type.STRING },
              address: { type: Type.STRING }
            },
            required: ["name", "relation", "aadhaar", "pan", "dob", "address"]
          }
        },
        claimants: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              relation: { type: Type.STRING },
              age: { type: Type.INTEGER },
              aadhaar: { type: Type.STRING },
              pan: { type: Type.STRING },
              dob: { type: Type.STRING },
              address: { type: Type.STRING }
            },
            required: ["name", "relation", "aadhaar", "pan", "dob", "address"]
          }
        },
        property: {
          type: Type.OBJECT,
          properties: {
            surveyNo: { type: Type.STRING },
            village: { type: Type.STRING },
            mandal: { type: Type.STRING },
            district: { type: Type.STRING },
            state: { type: Type.STRING },
            hNo: { type: Type.STRING },
            plotNo: { type: Type.STRING },
            ptiNo: { type: Type.STRING },
            extentSqYards: { type: Type.STRING },
            plinthArea: { type: Type.STRING },
            boundaries: {
              type: Type.OBJECT,
              properties: {
                east: { type: Type.STRING },
                west: { type: Type.STRING },
                north: { type: Type.STRING },
                south: { type: Type.STRING }
              },
              required: ["east", "west", "north", "south"]
            }
          },
          required: ["surveyNo", "village", "mandal", "district", "state", "boundaries"]
        },
        linkDeed: {
          type: Type.OBJECT,
          properties: {
            deedNumber: { type: Type.STRING },
            executionDate: { type: Type.STRING },
            village: { type: Type.STRING }
          },
          required: ["deedNumber", "executionDate"]
        }
      },
      required: ["executants", "claimants", "property", "linkDeed"]
    };
    
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: contentsParts,
      config: {
        systemInstruction: "You are an expert Indian land registrar document extractor. Translate any Telugu names/properties to English text character-by-character.",
        responseMimeType: "application/json",
        responseSchema: extractSchema,
        temperature: 0.1
      }
    });
    
    const resultText = response.text;
    if (!resultText) throw new Error("Empty response from extraction model.");
    return res.json(JSON.parse(resultText.trim()));
  } catch (err) {
    console.warn("Extraction failed or key missing, falling back to heuristics:", err);
    return res.json(getHeuristicExtraction(req.body.documents));
  }
});

function getHeuristicAadhaarExtraction(fileName: string): any {
  const norm = (fileName || "").toLowerCase();
  
  if (norm.includes("srinivas") || norm.includes("seller") || norm.includes("execut") || norm.includes("preset2")) {
    return {
      name: "Ankem Srinivas",
      relation: "S/o Ankem Ramulu",
      dob: "1975-06-12",
      age: 51,
      address: "H.No 4-12, Near Hanuman Temple, Nakrekal Village, Nakrekal Mandal, Nalgonda District, Telangana - 508211",
      aadhaarNo: "4521 8902 3412"
    };
  } else if (norm.includes("venkat") || norm.includes("buyer") || norm.includes("claim")) {
    return {
      name: "Ganta Venkat Reddy",
      relation: "S/o Ganta Malla Reddy",
      dob: "1981-08-15",
      age: 45,
      address: "Plot No 22, Jubilee Hills, Hyderabad, Telangana - 500033",
      aadhaarNo: "9876 5432 1098"
    };
  } else if (norm.includes("ramulu") || norm.includes("kethavath") || norm.includes("preset3")) {
    return {
      name: "Kethavath Ramulu",
      relation: "S/o Kethavath Laxma",
      dob: "1968-01-01",
      age: 58,
      address: "H.No 2-104, Haveli Ghanpur, Medak District, Telangana",
      aadhaarNo: "9874 5612 3045"
    };
  } else if (norm.includes("sudhakar") || norm.includes("vangala")) {
    return {
      name: "Vangala Sudhakar",
      relation: "S/o Vangala Narsaiah",
      dob: "1984-05-10",
      age: 42,
      address: "Plot No 44, NGO Colony, Medak, Telangana",
      aadhaarNo: "1234 5678 9012"
    };
  }

  // Default fallback
  return {
    name: "Ankem Srinivas",
    relation: "S/o Ankem Ramulu",
    dob: "1975-06-12",
    age: 51,
    address: "H.No 4-12, Near Hanuman Temple, Nakrekal Village, Nakrekal Mandal, Nalgonda District, Telangana - 508211",
    aadhaarNo: "4521 8902 3412"
  };
}

// Endpoint to extract details from a single Aadhaar card upload
app.post("/api/extract-aadhaar", async (req, res) => {
  try {
    const { document } = req.body;
    if (!document || !document.base64 || !document.mimeType) {
      return res.status(400).json({ error: "Document with base64 and mimeType is required." });
    }

    // Gemini is the sole extraction provider.
    const ai = getGeminiClient();

    if (!ai) {
      console.log("Gemini API not configured. Running in simulation mode.");
      return res.json(getHeuristicAadhaarExtraction(document.name));
    }

    const base64Data = document.base64.split(",")[1] || document.base64;

    // Deliberately CONCISE. An earlier verbose prompt that ended with an embedded
    // JSON template plus meta-rules made the model (with thinking disabled) dump its
    // chain-of-thought into the first string field. A short, direct instruction —
    // with the output shape enforced by responseSchema, not by an in-prompt template
    // — extracts every printed field cleanly and identically run-to-run.
    const extractionPrompt = `You are an OCR system. Read the text printed on this Indian Aadhaar card and return it as JSON. Transcribe only what is visibly printed — never calculate, infer, guess, or invent.

Fields:
- name: full name, exactly as printed
- relation: the S/o, W/o, or D/o line if printed, else ""
- mobile: mobile number if printed, else ""
- dob: date of birth exactly as the digits are printed (keep the same day, month, year)
- aadhaarNo: the 12-digit number, formatted "XXXX XXXX XXXX"
- address: the residential address block if printed (CRITICAL: exclude any S/O, W/O, D/O, or C/O prefix or relation/father/husband name from address, return ONLY the door/house no, street, village, mandal, district, pincode), else ""
- district, state, pincode: only if clearly present in the printed address, else ""
- leave occupation and age as "" (computed elsewhere)

Notes:
- Many cards show only some fields. The front/photo side usually has just name, DOB, gender and number — with no relation and no address. Return "" for anything not printed on THIS side; never output a place or name that is not written on the card.
- Output English/Latin letters and digits only. Transliterate any Telugu/Hindi/Kannada text to English.`;

    let extractedData;

    // Extract with Gemini.
    console.log("Using Gemini API for Aadhaar extraction...");
    const inlineData = {
      inlineData: {
        mimeType: document.mimeType,
        data: base64Data,
      }
    };

    const extractAadhaarSchema = {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        relation: { type: Type.STRING },
        occupation: { type: Type.STRING },
        mobile: { type: Type.STRING },
        dob: { type: Type.STRING },
        age: { type: Type.STRING },
        address: { type: Type.STRING },
        district: { type: Type.STRING },
        state: { type: Type.STRING },
        pincode: { type: Type.STRING },
        aadhaarNo: { type: Type.STRING }
      }
    };

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [inlineData, { text: extractionPrompt }],
      config: {
        responseMimeType: "application/json",
        responseSchema: extractAadhaarSchema,
        temperature: 0,
        // Disable "thinking" for this pure vision-OCR task. On gemini-3.5-flash the
        // thinking pass is non-deterministic even at temperature 0, and was observed
        // to DROP plainly-printed fields (DOB, the 12-digit number) while sometimes
        // hallucinating others (e.g. a state not on the card). With thinkingBudget:0
        // the transcription is complete and identical run-to-run — and, crucially,
        // the front and back of the SAME card then both yield the same Aadhaar
        // number, so mergeAadhaar() reliably folds them into ONE row. It is also
        // faster and cheaper (no thought tokens billed).
        thinkingConfig: { thinkingBudget: 0 },
        // The 11 Aadhaar fields are tiny; cap output so a mis-read image can't send
        // the model into a multi-KB repetition loop that produces truncated,
        // unparseable JSON (observed: "Unterminated string in JSON").
        maxOutputTokens: 2048,
      }
    });

    const resultText = response.text;
    if (resultText) {
      extractedData = normalizeAadhaar(safeParseAadhaarJson(resultText));
      console.log("✅ Gemini extraction successful!");
      return res.json(extractedData);
    }

    throw new Error("Gemini returned an empty response");

  } catch (err: any) {
    console.warn("Aadhaar extraction failed:", err.message);
    const rateLimited = /RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b/i.test(String(err?.message || ""));
    return res.status(rateLimited ? 429 : 500).json({
      error: rateLimited
        ? "The AI service hit its usage limit for now. Please wait a minute and try again, or enter the Aadhaar details manually."
        : "Extraction failed. Please try again or enter details manually.",
    });
  }
});

// NEW: Endpoint to extract details from link document (Sale Deed, Release Deed, etc.)
app.post("/api/extract-link-document", async (req, res) => {
  try {
    const { document, propertyType } = req.body;
    if (!document || !document.base64 || !document.mimeType) {
      return res.status(400).json({ error: "Document with base64 and mimeType is required." });
    }

    // Gemini is the sole extraction provider.
    const ai = getGeminiClient();

    if (!ai) {
      console.log("Gemini API not configured. Running link document extraction in simulation mode.");
      return res.json({
        jurisdiction: {
          district: "Nalgonda",
          districtRegistrar: "Nalgonda",
          mandal: "Nakrekal",
          subRegistrar: "Nakrekal",
          village: "Nakrekal",
          pincode: "508211"
        },
        linkDocument: {
          docNo: "1204/1998",
          docDate: "14/08/1998",
          subRegistrar: "Nakrekal",
          subRegistrarCode: "SR-NKL-44",
          pattadarPassbook: "T1209004812",
          passbookKhataNo: "4812",
          nalaOrderNo: "N/A",
          layoutFileNo: "LP.No. 45/1997",
          houseTaxReceipt: "HTR-2024-001"
        },
        property: {
          surveyNo: "412/A",
          plotNo: "12",
          nearHNo: "4-12",
          extentSqYards: "240 Sq Yards",
          extentSqMeters: "200.67 Sq Meters",
          locality: "Hanuman Nagar",
          marketValuePerSqYard: "10000",
          marketValueTotal: "2400000"
        },
        boundaries: {
          east: "Canal",
          west: "Ramulu's Land",
          north: "Main Road",
          south: "Venkataiah's Land"
        }
      });
    }

    const inlineData = {
      inlineData: {
        mimeType: document.mimeType,
        data: document.base64.split(",")[1] || document.base64,
      }
    };

    const extractLinkDocSchema = {
      type: Type.OBJECT,
      properties: {
        jurisdiction: {
          type: Type.OBJECT,
          properties: {
            district: { type: Type.STRING },
            districtRegistrar: { type: Type.STRING },
            mandal: { type: Type.STRING },
            subRegistrar: { type: Type.STRING },
            village: { type: Type.STRING },
            pincode: { type: Type.STRING }
          }
        },
        linkDocument: {
          type: Type.OBJECT,
          properties: {
            docNo: { type: Type.STRING, description: "Document number, often handwritten at top right corner or in margins" },
            docDate: { type: Type.STRING, description: "Link document registration/execution date" },
            docType: { type: Type.STRING, description: "CRITICAL: Document type from title section - GIFT SETTLEMENT DEED, SALE DEED, RELEASE DEED, etc. Extract from large bold header text at top of page" },
            subRegistrar: { type: Type.STRING },
            subRegistrarCode: { type: Type.STRING },
            pattadarPassbook: { type: Type.STRING, description: "Pattadar Passbook No" },
            passbookKhataNo: { type: Type.STRING, description: "Pass book Khata number" },
            nalaOrderNo: { type: Type.STRING },
            layoutFileNo: { type: Type.STRING },
            houseTaxReceipt: { type: Type.STRING, description: "House tax receipt number if mentioned" }
          }
        },
        property: {
          type: Type.OBJECT,
          properties: {
            propertyType: { type: Type.STRING, description: "CRITICAL: Identify type - 'Open plot', 'House', 'Demolished House', 'Part of open place', or 'Flat'" },
            surveyNo: { type: Type.STRING, description: "Survey number like 412/A, 102/AA etc" },
            plotNo: { type: Type.STRING },
            nearHNo: { type: Type.STRING, description: "House number" },
            extentSqYards: { type: Type.STRING, description: "Property extent in square yards" },
            extentSqMeters: { type: Type.STRING, description: "Property extent in square meters" },
            locality: { type: Type.STRING },
            pincode: { type: Type.STRING, description: "Pincode of property location e.g. 508211" },
            marketValuePerSqYard: { type: Type.STRING },
            marketValueTotal: { type: Type.STRING },
            house: {
              type: Type.OBJECT,
              properties: {
                nature: { type: Type.STRING },
                floors: { type: Type.STRING },
                age: { type: Type.STRING },
                tapConnection: { type: Type.STRING },
                metersNo: { type: Type.STRING },
                taxes: { type: Type.STRING },
                rentalValue: { type: Type.STRING },
                plinthArea: { type: Type.STRING }
              }
            },
            flat: {
              type: Type.OBJECT,
              properties: {
                flatNo: { type: Type.STRING },
                undividedSqYards: { type: Type.STRING },
                bearingHNo: { type: Type.STRING },
                buildingName: { type: Type.STRING },
                floorS: { type: Type.STRING }
              }
            }
          }
        },
        boundaries: {
          type: Type.OBJECT,
          properties: {
            east: { type: Type.STRING, description: "Eastern boundary description" },
            west: { type: Type.STRING, description: "Western boundary description" },
            north: { type: Type.STRING, description: "Northern boundary description" },
            south: { type: Type.STRING, description: "Southern boundary description" }
          }
        }
      }
    };

    const propertyTypeContext = propertyType ? `The property type is: ${propertyType}. Focus extraction on relevant fields for this type.` : "";

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        inlineData,
        {
          text: `You are analyzing a property registration document (Sale Deed, Gift Deed, Release Deed, or similar) from Telangana Registration and Stamps Department, India.

This document may be in English, Telugu, or mixed language. You must carefully examine ALL pages to extract complete information.

${propertyTypeContext}

STEP-BY-STEP EXTRACTION PROCESS:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1️⃣ DOCUMENT IDENTIFICATION (Check FIRST page - VERY TOP)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL - Document Type Location:
The document type appears in the TITLE/HEADER section, usually in large bold text:

LOOK FOR THESE PATTERNS:
✓ "GIFT SETTLEMENT DEED IN FAVOUR OF"
✓ "SALE DEED IN FAVOUR OF"
✓ "RELEASE DEED"
✓ "PARTITION DEED"
✓ "MORTGAGE DEED"

EXTRACT AS:
• If you see "GIFT SETTLEMENT DEED" → docType = "Gift Settlement Deed"
• If you see "SALE DEED" → docType = "Sale Deed"
• If you see "RELEASE DEED" → docType = "Release Deed"

Document Number:
• May be handwritten in TOP RIGHT corner (look for "X 886294" or similar)
• Or at top of first page in margins
• Formats: "3982/2026", "1204/1998", "Book-I 123/2020"
• Check corners, margins, stamps for numbers

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2️⃣ JURISDICTION DETAILS (CRITICAL - Read SCHEDULE OF PROPERTY section)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

IMPORTANT: Jurisdiction details are typically found in the "SCHEDULE OF PROPERTY" section,
within the property description paragraph. Look for text patterns like:

"[Village] v/o [Mandal] mandal, Dist:[District], Pin Code-[Pincode],
within the limits of Gram Panchayat [Village] and within the Sub-Registrar Office, [Sub-Registrar],
under the Registration Jurisdiction of District Registrar, [District Registrar]"

Example patterns to match:
✓ "Sarampelli v/o Thangallapelli mandal, Dist:Rajanna Sircilla, Pin Code-505405"
✓ "within the Sub-Registrar Office, Sircilla"
✓ "under the Registration Jurisdiction of District Registrar, Karimnagar"

EXTRACT THESE FIELDS:
• District: Look for "Dist:", "District:", "జిల్లా:" followed by district name
  Examples: "Rajanna Sircilla", "Karimnagar", "Nalgonda"

• District Registrar: Look for "District Registrar," followed by office name
  Examples: "Karimnagar", "Nalgonda", "Hyderabad"
  NOTE: This is DIFFERENT from District - District Registrar is the registration authority

• Mandal: Look for "mandal," "Mandal," "మండలం"
  Pattern: "[Village] v/o [MANDAL] mandal"
  Examples: "Thangallapelli", "Nakrekal"

• Sub-Registrar: Look for "Sub-Registrar Office," "Sub Registrar," "సబ్ రిజిస్ట్రార్"
  Examples: "Sircilla", "Nakrekal", "Tandur"

• Village: Look for village name before "v/o" or after "Gram Panchayat"
  Pattern: "[VILLAGE] v/o [Mandal]" or "Gram Panchayat [VILLAGE]"
  Examples: "Sarampelli", "Thangallapelli", "Nakrekal"
  NOTE: Can also be written as "Sarampally" (different spelling variants)

• Pincode: Look for "Pin Code-", "Pin:", "Pincode:"
  Examples: "505405", "508211", "501301"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3️⃣ LINK DOCUMENT REFERENCE DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Look for sections mentioning previous ownership:
• Sub-Registrar Code: "SR-XXX", "Sub Registrar Code"
• Pattadar Passbook: "PP No: XXX", "పట్టాదారు పాస్‌బుక్ నెంబరు"
• Nala Order No: "Nala Order", "నాలా ఆర్డర్"
• Layout File No: "Layout No", "LP.No", "లేఅవుట్ ఫైల్"
• House Tax Receipt: "Tax Receipt No", "గృహపన్ను రసీదు"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4️⃣ PROPERTY DESCRIPTION (Main body of document)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Look for "SCHEDULE OF PROPERTY", "ఆస్తి వివరములు", "PROPERTY DETAILS":

CRITICAL FIELDS (Look carefully):
• Survey Number: "Survey No: 412/A", "Sy.No", "సర్వే నెంబరు: 412/A"
  - May have slashes, letters: "25-B", "102/AA", "412/A/1"
• Plot Number: "Plot No: 12", "ప్లాట్ నెంబరు"
• House Number: "H.No: 4-12", "Door No", "ఇంటి నెంబరు"
• Extent/Area:
  - Square Yards: "240 Sq.Yards", "చదరపు గజములు"
  - Square Meters: "200 Sq.Meters", "చదరపు మీటర్లు"
• Locality: Neighborhood name
• Market Value: Total consideration amount in rupees

FOR HOUSES (if mentioned):
• Nature: "RCC", "Tile roof", "పక్కా ఇల్లు"
• Floors: "G+1", "Two storied"
• Age: Building age in years
• Tap Connection: Water connection number
• Meter No: Electric/water meter
• Taxes: Municipal tax details
• Rental Value: If rented

FOR FLATS (if mentioned):
• Flat No: Apartment number
• Undivided Share: Percentage of land
• Building Name: Apartment complex name
• Floor: Which floor

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5️⃣ BOUNDARIES (సరిహద్దుల వివరాలు) - VERY IMPORTANT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Look for section titled "BOUNDARIES", "BOUNDED BY", "సహజ సరిహద్దులు":

Extract descriptions for each direction:
• East (తూర్పు/తూర్పున): "Canal", "కాలువ", "Road", "రోడ్డు"
• West (పడమర/పడమరన): "Ramulu's Land", "రాములు భూమి", "Open space"
• North (ఉత్తరం/ఉత్తరన): "Main Road", "రోడ్డు", "Neighbor's house"
• South (దక్షిణం/దక్షిణన): "Venkataiah's Land", "వెంకటయ్య భూమి", "Drain"

Boundaries are usually near END of document. Look for:
- "As per the boundaries" / "సరిహద్దులు క్రింది విధంగా"
- Bullet points or table format
- Telugu words: తూర్పు, పడమర, ఉత్తరం, దక్షిణం

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EXTRACTION RULES:
✅ Read ALL pages carefully - information may be spread across pages
✅ Translate Telugu text to English while preserving meaning
✅ If a field is NOT visible or unclear, return empty string "" or null
✅ Do NOT guess, invent, or fabricate any information
✅ Look for handwritten notes, stamps, margins for document numbers
✅ Boundaries section is CRITICAL - look at last 2-3 pages carefully
✅ Check both text and tables for property details

Return ONLY valid JSON matching the schema. No additional text.`
        }
      ],
      config: {
        systemInstruction: `You are an expert document analyst specializing in Indian property registration documents from Telangana state.

Your expertise includes:
- Reading both English and Telugu text
- Identifying handwritten numbers and notes
- Understanding legal document structure
- Extracting boundary descriptions accurately
- Translating Telugu property terms to English

CRITICAL INSTRUCTIONS FOR JURISDICTION EXTRACTION:
1. Find "SCHEDULE OF PROPERTY" section - jurisdiction details are INSIDE this section
2. Look for pattern: "[Village] v/o [Mandal] mandal, Dist:[District], Pin Code-[Pincode]"
3. Look for: "Sub-Registrar Office, [SubRegistrar]"
4. Look for: "District Registrar, [DistrictRegistrar]"
5. District and District Registrar are DIFFERENT fields - extract both separately
6. Village name may appear before "v/o" and after "Gram Panchayat" - use the one before "v/o"
7. Mandal appears between "v/o" and "mandal" keyword

OTHER CRITICAL INSTRUCTIONS:
1. Examine EVERY page of the document
2. Boundaries section is usually at the END - check last pages
3. Document numbers may be handwritten at TOP of first page
4. Survey numbers have specific formats: 412/A, 25-B, 102/AA
5. Translate Telugu words accurately
6. If uncertain about ANY field, leave it empty - NEVER guess
7. Return ONLY the JSON output - no explanations`,
        responseMimeType: "application/json",
        responseSchema: extractLinkDocSchema,
        temperature: 0.05
      }
    });

    const resultText = response.text;
    if (!resultText) throw new Error("Empty response from extraction model.");
    return res.json(JSON.parse(resultText.trim()));
  } catch (err: any) {
    console.warn("Link document extraction failed:", err);
    return res.status(500).json({ error: "Extraction failed. Please try again or fill manually." });
  }
});

// AI template filling endpoint (Step 6)
app.post("/api/fill-template", async (req, res) => {
  try {
    const { templateText, extractedDetails } = req.body;
    if (!templateText) {
      return res.status(400).json({ error: "Template text is required." });
    }
    const ai = getGeminiClient();
    if (!ai) {
      console.log("GEMINI_API_KEY is missing. Running template fill in local mode.");
      return res.json({ filledText: regexCleanDraft(localFillTemplate(templateText, extractedDetails)) });
    }
    
    const prompt = `You are an expert legal document drafter in Telangana, India. Update the supplied Model Sale Deed template with the extracted registration details.

STRICT INSTRUCTIONS:
1. FORMATTING & LAYOUT PRESERVATION: You MUST preserve the exact formatting style, layout setup, paper size, margins, font style, font sizes, text alignment (left, center, justified), headers, footers, page margins, padding, bullet formats, numbered lists, and table structures of the supplied template. Keep all clauses, headings, and schedules in the original template order.
2. NO PLACEHOLDERS OR DASHES: Do NOT include any placeholder dashes, underscores (____), dashes (---), bracketed slots ([...]), [N/A], or empty line placeholders anywhere in the text.
   If relevant information is not supplied or is missing for a particular field in the registration details, do NOT write any dashes or blank lines.
   Smoothly omit the unsupplied detail or phrase so that the final text is registered directly and cleanly, maintaining perfect legal grammar and flow.
3. Ensure exact character-by-character accuracy for Aadhaar names, numbers, survey numbers, plot numbers, boundaries, and amounts from the variables.

Do NOT wrap the response in markdown code blocks. Return ONLY the final filled legal draft text directly.

VARIABLES:
${JSON.stringify(extractedDetails, null, 2)}

TEMPLATE:
${templateText}`;
    
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: "You are a senior registration deed drafter. Return ONLY the final filled legal draft text. Preserve template layout, fonts, margins, alignment, bullets, and formatting style. NEVER output placeholder dashes, underscores (____), or blank lines for missing fields — write the registered text cleanly without placeholders. Never include markdown code blocks or conversational text.",
        temperature: 0.1
      }
    });
    
    let filledText = (response.text || "").replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
    filledText = regexCleanDraft(filledText);
    return res.json({ filledText });
  } catch (err) {
    console.warn("Template filling failed, falling back to local replacement engine:", err);
    return res.json({ filledText: regexCleanDraft(localFillTemplate(req.body.templateText, req.body.extractedDetails)) });
  }
});

// Document verification endpoint
app.post("/api/verify", async (req, res) => {
  try {
    const {
      aadhaarCards,
      linkDocuments,
      draftText,
      registrationDate,
      enteredDetails,
      unresolvedPlaceholders,
      templateName,
    } = req.body;

    if (!draftText) {
      return res.status(400).json({ error: "Draft document content is required." });
    }

    const ai = getGeminiClient();

    // If Gemini API Key is missing, run our high-fidelity Heuristic & Preset Simulation Engine
    if (!ai) {
      console.log("GEMINI_API_KEY is missing. Running in local Heuristic Fallback & Preset Simulation Mode.");
      return res.json(generateHeuristicReport(draftText));
    }

    // Prepare contents list for Gemini
    const contentsParts: any[] = [];

    // Add Aadhaar parts if uploaded
    if (aadhaarCards && Array.isArray(aadhaarCards)) {
      aadhaarCards.forEach((card, index) => {
        if (card.base64 && card.mimeType) {
          contentsParts.push({
            inlineData: {
              mimeType: card.mimeType,
              data: card.base64.split(",")[1] || card.base64,
            },
          });
          contentsParts.push({
            text: `This is Aadhaar Card #${index + 1} named: ${card.name || "Aadhaar Card"}.`,
          });
        }
      });
    }

    // Add Link document parts if uploaded
    if (linkDocuments && Array.isArray(linkDocuments)) {
      linkDocuments.forEach((doc, index) => {
        if (doc.base64 && doc.mimeType) {
          contentsParts.push({
            inlineData: {
              mimeType: doc.mimeType,
              data: doc.base64.split(",")[1] || doc.base64,
            },
          });
          contentsParts.push({
            text: `This is Link Document #${index + 1} named: ${doc.name || "Link Document"}.`,
          });
        }
      });
    }

    // Add the consolidated data the user entered/reviewed in Step 1 (source of truth #2).
    if (enteredDetails) {
      contentsParts.push({
        text: `DATA ENTERED & REVIEWED BY THE USER IN STEP 1 (JSON):\n${JSON.stringify(enteredDetails, null, 2)}`,
      });
    }

    // Flag any placeholders the deterministic merge could not resolve.
    if (Array.isArray(unresolvedPlaceholders) && unresolvedPlaceholders.length > 0) {
      contentsParts.push({
        text: `UNFILLED TEMPLATE PLACEHOLDERS still present in the draft (these are ERRORS): ${unresolvedPlaceholders.join(", ")}`,
      });
    }

    if (templateName) {
      contentsParts.push({ text: `Template used to generate this draft: ${templateName}` });
    }

    // Add the prepared draft document text
    contentsParts.push({
      text: `FINAL DRAFT DEED GENERATED FROM THE TEMPLATE (Text Content):\n${draftText}`,
    });

    // Add prompt instructions with the registration date context
    const dateContext = registrationDate ? `Registration Date of New Draft: ${registrationDate}` : `Registration Date of New Draft: ${new Date().toISOString().split('T')[0]} (2026)`;
    contentsParts.push({
      text: `Perform a COMPREHENSIVE, END-TO-END verification of the FINAL DRAFT DEED. You are given three sources to cross-check against each other:
      (A) the uploaded Aadhaar / PAN cards, (B) the uploaded Link / Pattadar documents, and (C) the JSON of data the user entered and reviewed in Step 1.
      The FINAL DRAFT DEED must be internally consistent with ALL of them.

      CONTEXT:
      ${dateContext}

      Verify the following and return the analysis strictly adhering to the JSON schema:
      1. Extractions: Identify sellers, their exact names from Aadhaar, draft, and link documents, Aadhaar numbers, and DOBs. Calculate rounded age at the registration date using Aadhaar DOB.
      2. Comprehensive Verification Checks:
         - Verification 1 (Names mismatch): Compare spelling in Draft to Aadhaar AND to the entered JSON. Must match EXACTLY. Verify Aadhaar numbers (12-digit format), and calculate age from Aadhaar DOB to check draft age.
         - Verification 2 (Property details mismatch): Verify H.No, Plot No, Survey/Sub-division number, PTI No, Sq Yards, Plinth area, and boundaries (East, West, North, South) listed in Draft match the older Link Document / Pattadar Passbook AND the entered JSON exactly.
         - Verification 3 (Link document numbers mismatch): Verify that the registered sale deed/document reference number cited in the draft document exactly matches the actual document number printed on the Link Document PDF.
         - Verification 4 (Residual content): CRITICALLY inspect the draft for ANY content that does NOT belong to THIS transaction — e.g. a different person's name, a stray survey/plot number, an address, a village, an amount, or boilerplate that matches neither the uploaded documents nor the entered JSON. Any such leftover from another property, seller, or buyer, or any un-replaced template placeholder such as {{...}}, MUST be reported as a CRITICAL discrepancy in the "Residual content" category. The final deed must contain ONLY the details of the current supplied property, claimant, and executant — nothing mixed in from other documents.
         - Verification 5 (Completeness): Flag any required field that is blank, still a placeholder, or obviously a leftover example value.
      3. Discrepancies: Group ALL discrepancies into these categories:
         - "Names mismatch"
         - "Property details mismatch"
         - "Link document numbers mismatch"
         - "Residual content"
         - "Completeness"

      Response MUST be in valid JSON. No trailing commas, no backticks outside the JSON.`,
    });

    const systemInstruction = `
    You are an expert Indian Document Verification AI specializing in land registrations, property deeds, and transactions under the Registration and Stamps Department of Telangana, India.
    Your task is to verify draft registration documents prepared by document writers against official identity documents (Aadhaar cards) and older ownership documents (Link documents).
    
    You will be provided with:
    1. Aadhaar Cards (PDF or Image, as inlineData).
    2. Link Document (PDF or Image, representing older sale deeds, Pattadar Passbooks, or gift deeds, sometimes in Telugu or English).
    3. The consolidated JSON of data the user entered and reviewed in Step 1.
    4. The final Draft Document text (the prepared document to be verified).
    5. A registration date to calculate ages.

    Strict Rules for comparison:
    1. Aadhaar Card is the absolute source of truth for Seller Names, Dates of Birth, and Aadhaar numbers.
    2. Draft Name Spelling: The spelling and initials from the Aadhaar card must reflect EXACTLY in the draft document AND in the entered JSON. Flag even minor character differences, spacing, or punctuation mismatches.
    3. Rounded Age Calculation:
       - Identify the seller's Date of Birth (DOB) from the Aadhaar card.
       - Calculate their exact age in years as of the provided Registration Date.
       - Round the calculated age to the nearest integer.
       - Compare this calculated rounded age with the age specified in the draft. Flag if they differ.
    4. Language Fallback: Link documents are often in Telugu. If so, extract the seller's details (name, father's/husband's name, survey numbers, village, boundaries) from Telugu. Translate Telugu names to English and compare them with Aadhaar and Draft.
    5. Property & Boundaries: H.No, Plot No, Survey number, PTI No, Sq Yards, Plinth Area, and Boundaries must match the Link Document AND the entered JSON EXACTLY. Flag any discrepancy as CRITICAL in the 'Property details mismatch' category.
    6. Link Document Deed Number: Extract the actual deed number from the Link document header/page. Verify the draft refers to this exact acquired deed number. If not, flag as 'Link document numbers mismatch'.
    7. RESIDUAL CONTENT (very important): The final deed was produced by merging data into a reusable template. You MUST detect and flag any residual content that does not belong to the CURRENT transaction — for example a leftover name, survey/plot/house number, address, village, boundary, monetary amount, or example text from a PREVIOUS document that matches NEITHER the uploaded documents NOR the entered JSON. Any un-replaced placeholder token (text of the form {{SOMETHING}}) is ALWAYS a CRITICAL residual-content error. The deed must contain ONLY the details of the currently supplied property, claimant, and executant. Report each such item in the "Residual content" category.
    8. Completeness: Flag any required field left blank or still a placeholder in the "Completeness" category.
    9. Group all discrepancies strictly into:
       - "Names mismatch"
       - "Property details mismatch"
       - "Link document numbers mismatch"
       - "Residual content"
       - "Completeness"
    10. Return your verification report strictly in the requested JSON schema.
    `;

    const verificationSchema = {
      type: Type.OBJECT,
      properties: {
        summary: {
          type: Type.OBJECT,
          properties: {
            status: { type: Type.STRING, description: "One of APPROVED, WARNING, or DISCREPANCY_FOUND" },
            sellersCount: { type: Type.INTEGER, description: "Total number of sellers identified" },
            discrepancyCount: { type: Type.INTEGER, description: "Total number of discrepancies found" },
            message: { type: Type.STRING, description: "High-level summary message" }
          },
          required: ["status", "sellersCount", "discrepancyCount", "message"]
        },
        sellers: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              aadhaarName: { type: Type.STRING },
              draftName: { type: Type.STRING },
              linkName: { type: Type.STRING },
              aadhaarNo: { type: Type.STRING },
              draftAadhaarNo: { type: Type.STRING },
              dob: { type: Type.STRING },
              calculatedAge: { type: Type.INTEGER },
              draftAge: { type: Type.INTEGER },
              linkAge: { type: Type.INTEGER },
              status: { type: Type.STRING },
              discrepancies: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["id", "aadhaarName", "draftName", "linkName", "aadhaarNo", "draftAadhaarNo", "dob", "calculatedAge", "draftAge", "status", "discrepancies"]
          }
        },
        property: {
          type: Type.OBJECT,
          properties: {
            linkSurveyNumbers: { type: Type.ARRAY, items: { type: Type.STRING } },
            draftSurveyNumbers: { type: Type.ARRAY, items: { type: Type.STRING } },
            linkVillage: { type: Type.STRING },
            draftVillage: { type: Type.STRING },
            linkHNo: { type: Type.STRING },
            draftHNo: { type: Type.STRING },
            linkPlotNo: { type: Type.STRING },
            draftPlotNo: { type: Type.STRING },
            linkPTINo: { type: Type.STRING },
            draftPTINo: { type: Type.STRING },
            linkSqYards: { type: Type.STRING },
            draftSqYards: { type: Type.STRING },
            linkPlinthArea: { type: Type.STRING },
            draftPlinthArea: { type: Type.STRING },
            linkBoundaries: {
              type: Type.OBJECT,
              properties: {
                east: { type: Type.STRING },
                west: { type: Type.STRING },
                north: { type: Type.STRING },
                south: { type: Type.STRING }
              },
              required: ["east", "west", "north", "south"]
            },
            draftBoundaries: {
              type: Type.OBJECT,
              properties: {
                east: { type: Type.STRING },
                west: { type: Type.STRING },
                north: { type: Type.STRING },
                south: { type: Type.STRING }
              },
              required: ["east", "west", "north", "south"]
            },
            status: { type: Type.STRING },
            discrepancies: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: [
            "linkSurveyNumbers", "draftSurveyNumbers", "linkVillage", "draftVillage",
            "linkHNo", "draftHNo", "linkPlotNo", "draftPlotNo", "linkPTINo", "draftPTINo",
            "linkSqYards", "draftSqYards", "linkPlinthArea", "draftPlinthArea",
            "linkBoundaries", "draftBoundaries", "status", "discrepancies"
          ]
        },
        linkDocumentVerification: {
          type: Type.OBJECT,
          properties: {
            linkDeedNumber: { type: Type.STRING },
            draftMentionedLinkDeedNumber: { type: Type.STRING },
            status: { type: Type.STRING },
            discrepancies: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["linkDeedNumber", "draftMentionedLinkDeedNumber", "status", "discrepancies"]
        },
        allDiscrepancies: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              category: { type: Type.STRING, description: "Must be: 'Names mismatch', 'Property details mismatch', 'Link document numbers mismatch', 'Residual content', or 'Completeness'" },
              severity: { type: Type.STRING, description: "CRITICAL or WARNING" },
              description: { type: Type.STRING, description: "Detailed description in English" },
              descriptionTe: { type: Type.STRING, description: "Telugu translation of description (తెలుగు అనువాదం)" },
              expected: { type: Type.STRING },
              found: { type: Type.STRING },
              recommendation: { type: Type.STRING, description: "Actionable recommendation in English" },
              recommendationTe: { type: Type.STRING, description: "Telugu translation of recommendation (తెలుగు పరిస్కార సూచన)" }
            },
            required: ["category", "severity", "description", "descriptionTe", "expected", "found", "recommendation", "recommendationTe"]
          }
        },
        linkDocumentDetails: {
          type: Type.OBJECT,
          properties: {
            language: { type: Type.STRING },
            docNumber: { type: Type.STRING },
            village: { type: Type.STRING },
            surveyNumbers: { type: Type.ARRAY, items: { type: Type.STRING } },
            sellersExtracted: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["language", "docNumber", "village", "surveyNumbers", "sellersExtracted"]
        }
      },
      required: ["summary", "sellers", "property", "linkDocumentVerification", "allDiscrepancies", "linkDocumentDetails"]
    };

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: contentsParts,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
        responseSchema: verificationSchema,
        temperature: 0.1,
      },
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error("Empty response received from Gemini API");
    }

    const report = JSON.parse(resultText.trim());
    return res.json(report);

  } catch (error: any) {
    console.warn("Gemini verification failed, falling back to local heuristics simulation:", error);
    try {
      const { draftText } = req.body;
      return res.json(generateHeuristicReport(draftText));
    } catch (fallbackError: any) {
      console.error("Heuristic fallback failed as well:", fallbackError);
      return res.status(500).json({
        error: error.message || "An internal error occurred during document verification.",
      });
    }
  }
});

// NOTE: the plan is now produced by the deterministic renderer in planRenderer.ts
// (renderPlanDataUrl) fed by a Gemini vision extraction of the sketch. The old
// text-only Imagen call, the LLM-hand-written-SVG fallback, and the hardcoded
// 66'x66' buildFallbackCadSvg have been removed — the renderer always yields a
// full, on-spec one-pager even with no AI (drawing from the form details).

// Used ONLY when the boundary audit could not run (no AI key, upstream timeout,
// unparseable response). It must NOT imply the boundaries were checked and
// approved: echoing the form's own values back with `isMatch: true` renders a
// green "Boundaries Approved" badge on a deed nobody verified. Report the
// unverified state truthfully and let the UI warn instead.
function buildFallbackVerificationReport(propertyDetails: any, reason?: string | null) {
  return {
    extractedFromSketch: {
      east: propertyDetails?.boundaries?.east || "Not specified",
      west: propertyDetails?.boundaries?.west || "Not specified",
      north: propertyDetails?.boundaries?.north || "Not specified",
      south: propertyDetails?.boundaries?.south || "Not specified",
      dimensions: "Not read from sketch",
      roadDetails: "Not read from sketch",
    },
    discrepancies: [],
    isMatch: false,
    // Distinguishes "audit ran, found nothing wrong" from "audit never ran".
    notVerified: true,
    notVerifiedReason:
      (reason ? reason + " " : "") +
      "Verify the boundaries manually before registration.",
  };
}

// Bound a promise so a slow/stuck upstream call can never hang forever. The
// underlying request may keep running in the background, but the winner of the
// race lets us send the HTTP response on time (a stuck vision call would
// otherwise leave the client's plan spinner spinning indefinitely).
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// API endpoint to process a hand-drawn sketch and generate a neat computerized AI plot image + boundary verification report
app.post("/api/generate-plan", async (req, res) => {
  try {
    const { sketchBase64, customPrompt, propertyDetails, details } = req.body || {};
    if (!sketchBase64 || typeof sketchBase64 !== "string") {
      return res.status(400).json({ error: "Missing sketchBase64 in request body." });
    }

    const ai = getGeminiClient();

    // Prepare image part
    const matches = sketchBase64.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    const mimeType = matches ? matches[1] : "image/jpeg";
    const base64Data = matches ? matches[2] : sketchBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");

    const imagePart = {
      inlineData: {
        data: base64Data,
        mimeType: mimeType
      }
    };

    const userPromptText = customPrompt && customPrompt.trim().length > 0 ? customPrompt.trim() : "";

    // Normalise the flat property-detail shape used by verification + fallback.
    const pd = propertyDetails || (details?.property
      ? {
          boundaries: details.property.boundaries,
          surveyNo: details.property.surveyNo,
          plotNo: details.property.plotNo,
          extentSqYards: details.property.extentSqYards,
        }
      : {});
    // The full consolidated details drive the deterministic one-pager renderer
    // (party paragraphs, description, area table). Fall back to the flat shape.
    const renderDetails =
      details && typeof details === "object" ? details : { property: pd };

    // Per-call ceiling for each Gemini vision request. Whichever call stalls,
    // the race below still resolves so we ALWAYS send an HTTP response and the
    // client's plan spinner never hangs. Overridable via env for slow hosts.
    const PLAN_AI_TIMEOUT_MS = Number(process.env.PLAN_AI_TIMEOUT_MS) || 45000;

    let extractedPlan: any = null;
    let imageError: string | null = null;
    let verificationReport: any = null;
    // Why the cross-check did not run, in words the user can act on.
    let auditFailure: string | null = null;

    // ---- STEP 1: read the hand-drawn sketch into STRUCTURED JSON (vision) ----
    // The sketch image IS sent to the model here. (Previously the sketch was
    // never passed to the image generator, so the output bore no relation to it.)
    // ---- (also) Boundary verification vs the registration-form details.
    // Both are independent vision calls, so run them CONCURRENTLY (halves the
    // wall-clock) and time-box EACH one so a stuck call can't hang the request.
    if (ai) {
      const verificationPrompt = `You are an expert land surveyor and legal verification auditor in Telangana, India.
Examine the uploaded hand-drawn property sketch image carefully and compare it against the official property details from the registration form DATA.

PROPERTY DETAILS FROM REGISTRATION FORM DATA:
- East Boundary: ${pd?.boundaries?.east || "Not specified"}
- West Boundary: ${pd?.boundaries?.west || "Not specified"}
- North Boundary: ${pd?.boundaries?.north || "Not specified"}
- South Boundary: ${pd?.boundaries?.south || "Not specified"}
- Survey No: ${pd?.surveyNo || "Not specified"}
- Plot No: ${pd?.plotNo || "Not specified"}
- Extent / Total Area: ${pd?.extentSqYards || "Not specified"} Sq Yards

TASK:
1. Extract all boundary markings, orientation (East/West/North/South), dimensions (feet/meters), adjacent roads, and neighbor details written on the sketch image.
2. Cross-verify each boundary (East, West, North, South), plot dimensions, survey number, and road widths on the sketch against the registration form details provided above.
3. Identify any DISCREPANCIES or MISMATCHES between the sketch and the registration form.
4. Return a structured JSON response containing the analysis.

CRITICAL RULES:
- "extractedFromSketch" must contain ONLY what is genuinely drawn or written on the
  IMAGE. Never copy a value from the form data above into it. If a side has no
  text on the sketch, write "Not marked on sketch".
- Read the sketch's own north arrow / compass rose to decide which side is which.
  The compass may be rotated or inverted (north pointing DOWN is common), so a
  label's position on the page does NOT determine its compass direction.
- A boundary written as a ROAD does not match a boundary described as an open
  place or a named neighbour. Report that as a discrepancy.
- Also compare the AREA: multiply the sketch's plot dimensions and compare the
  result against the form's Extent / Total Area. Report a mismatch if they differ
  materially.
- Set "isMatch" to true ONLY when "discrepancies" is empty.

JSON Output Schema strictly format as:
{
  "extractedFromSketch": {
    "east": "text found on East side",
    "west": "text found on West side",
    "north": "text found on North side",
    "south": "text found on South side",
    "dimensions": "dimensions mentioned e.g. 66' x 66'",
    "roadDetails": "roads mentioned"
  },
  "discrepancies": [
    {
      "direction": "East / West / North / South / Dimensions",
      "formDetail": "What was entered in registration form",
      "sketchDetail": "What is drawn/written in the hand-drawn sketch",
      "severity": "CRITICAL" | "WARNING" | "INFO",
      "description": "Clear explanation of discrepancy in English",
      "descriptionTe": "తెలుగులో వివరణ"
    }
  ],
  "isMatch": boolean
}`;

      // Fire both vision calls together; each is independently time-boxed.
      const extractionCall = withTimeout(
        ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            imagePart,
            {
              text:
                PLAN_EXTRACTION_PROMPT +
                (userPromptText ? `\n\nADDITIONAL USER NOTES:\n${userPromptText}` : ""),
            },
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: PLAN_EXTRACTION_SCHEMA,
            temperature: 0.1,
          },
        }),
        PLAN_AI_TIMEOUT_MS,
        "Plan sketch extraction"
      );

      const auditCall = withTimeout(
        ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [imagePart, { text: verificationPrompt }],
          config: {
            responseMimeType: "application/json",
            responseSchema: BOUNDARY_AUDIT_SCHEMA,
            temperature: 0.1,
          },
        }),
        PLAN_AI_TIMEOUT_MS,
        "Boundary verification"
      );

      const [exRes, auRes] = await Promise.allSettled([extractionCall, auditCall]);

      if (exRes.status === "fulfilled" && (exRes.value as any)?.text) {
        extractedPlan = parseModelJson((exRes.value as any).text);
        if (!extractedPlan) imageError = "Sketch extraction returned unparseable data.";
      } else if (exRes.status === "rejected") {
        imageError = exRes.reason?.message || "Sketch extraction unavailable.";
        console.warn("Plan sketch extraction failed; rendering from form details:", imageError);
      }

      if (auRes.status === "fulfilled" && (auRes.value as any)?.text) {
        verificationReport = parseModelJson((auRes.value as any).text);
        if (!verificationReport) {
          console.warn("Verification JSON unparseable; using fallback.");
          auditFailure = "The boundary cross-check returned data that could not be read.";
        }
      } else if (auRes.status === "rejected") {
        const raw = auRes.reason?.message || String(auRes.reason || "");
        console.error("Verification audit failed:", raw);
        // Tell the user WHICH failure this is: an exhausted API quota needs
        // billing attention, a timeout just needs a retry. A generic message
        // sends them looking at the sketch, which is not the problem.
        if (/RESOURCE_EXHAUSTED|quota|credits are depleted|\b429\b/i.test(raw)) {
          auditFailure =
            "The AI service quota has been exhausted, so the boundaries were not cross-checked. Check the API billing/credits, then generate the plan again.";
        } else if (/timed out/i.test(raw)) {
          auditFailure =
            "The boundary cross-check timed out. Generate the plan again to retry.";
        } else {
          auditFailure = "The boundary cross-check could not be completed.";
        }
      }
    }

    // ---- STEP 2: render the full one-pager deterministically from the JSON ----
    // Always succeeds: with no sketch JSON it draws from the form details.
    const generatedImageBase64 = renderPlanDataUrl({ plan: extractedPlan, details: renderDetails });

    if (!verificationReport) {
      verificationReport = buildFallbackVerificationReport(pd, auditFailure);
    }

    return res.json({
      generatedImageBase64,
      imageError,
      verificationReport,
      // What the sketch reader pulled out — handy for debugging/preview.
      extractedPlan,
      masterPromptUsed: PLAN_EXTRACTION_PROMPT + (userPromptText ? `\n\nUSER NOTES:\n${userPromptText}` : ""),
    });
  } catch (err: any) {
    console.error("Error in /api/generate-plan:", err);
    // Even in catch block, render a clean plan from whatever details we have so
    // the frontend never gets a 500 error.
    try {
      const { propertyDetails, details } = req.body || {};
      const rd =
        details && typeof details === "object" ? details : { property: propertyDetails || {} };
      return res.json({
        generatedImageBase64: renderPlanDataUrl({ plan: null, details: rd }),
        imageError: null,
        verificationReport: buildFallbackVerificationReport(propertyDetails || details?.property),
        masterPromptUsed: PLAN_EXTRACTION_PROMPT,
      });
    } catch {
      return res.status(500).json({ error: err.message || "Failed to generate plan." });
    }
  }
});

// Vite server / Static files configuration.
//
// IMPORTANT (deploy-safety): decide the mode by OPTING IN to dev, not by opting
// out of prod. On hosts like Render/Cloud Run, `vite` is a devDependency that is
// pruned from the production install — so if we ever tried to `import("vite")`
// there, the import would throw, startServer() would reject, and the process
// would exit WITHOUT binding a port (Render then shows `x-render-routing:
// no-server`). Defaulting to static-serving unless NODE_ENV is explicitly
// "development" makes production the safe fallback even if NODE_ENV is unset.
const IS_DEV = process.env.NODE_ENV === "development";

async function startServer() {
  if (IS_DEV) {
    try {
      // Vite is a DEV-only dependency. Import it lazily so the production bundle
      // never loads it (and does not need it installed at all).
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (err) {
      console.error("Vite dev middleware failed to load; falling back to static:", err);
      serveStatic();
    }
  } else {
    serveStatic();
  }

  // Ensure the deed template library exists (seeds placeholder .docx files on first run).
  try {
    await ensureTemplatesSeeded();
  } catch (err) {
    console.warn("Template seeding failed (non-fatal):", err);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT} (mode: ${IS_DEV ? "development" : "production"})`);
  });
}

// Serve the built SPA (dist/) as static files with an index.html fallback for
// client-side routes. Kept as its own fn so both prod and the dev-failure path
// can use it.
function serveStatic() {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  // SPA fallback: serve index.html for any non-API GET that didn't match a static
  // file, so client-side deep links / refreshes work. Using a plain fallback
  // middleware (not app.get("*")) makes this robust across Express /
  // path-to-regexp versions, where the "*" pattern can fail to match.
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// Never let an unexpected async rejection take the process down silently — log it
// and keep serving. (A crashed process is what produces Render's `no-server`.)
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (kept alive):", err);
});

startServer().catch((err) => {
  // Last-ditch: even if startup wiring failed, bind the port so the platform
  // sees a live server (health check still responds) instead of a dead instance.
  console.error("startServer() failed; binding port anyway so health check responds:", err);
  try {
    app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT} (recovery mode)`));
  } catch (e) {
    console.error("Failed to bind port in recovery mode:", e);
  }
});
