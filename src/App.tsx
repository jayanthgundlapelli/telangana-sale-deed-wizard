import React, { useState, useEffect, useRef } from "react";
import * as mammoth from "mammoth";
import DocxLivePreview from "./DocxLivePreview";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileText,
  UploadCloud,
  UserCheck,
  MapPin,
  Calendar,
  Building2,
  HelpCircle,
  RefreshCw,
  Search,
  FileCheck2,
  Plus,
  Trash2,
  Languages,
  Copy,
  Sparkles,
  Info,
  ChevronRight,
  ChevronLeft,
  Printer,
  Edit2,
  Lock,
  Unlock,
  Download,
  Save,
  BookOpen,
  ArrowRight,
  Database,
  Coins,
  Maximize2,
  X,
  FileUp,
  ShieldCheck
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { PRESETS, MODEL_TEMPLATES, Preset, MockFile, ModelTemplate } from "./presets";
import AiStatusBanner from "./AiStatusBanner";
import {
  ApiFailure,
  parseApiFailure,
  toApiFailure,
  degradedFailure,
} from "./aiError";

// Compute the COMPLETED (last-birthday) age from a date of birth. Parses the
// three shapes an Aadhaar/date-input can produce — ISO YYYY-MM-DD, DD/MM/YYYY (or
// DD-MM-YYYY), and a bare birth YEAR (many Aadhaar cards print only the year) —
// using explicit numeric parts rather than `new Date(string)`, which is
// timezone-fragile (an ISO date parses as UTC midnight and can slip to the
// previous day in a behind-UTC locale, throwing the age off by a year).
const calculateAgeFromDOB = (dobString: string): string => {
  if (!dobString) return "";
  const s = String(dobString).trim();
  let y: number | null = null;
  let m = 1; // month/day default to Jan 1 for year-only cards (best-effort)
  let d = 1;
  let mm: RegExpMatchArray | null;
  if ((mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    y = +mm[1]; m = +mm[2]; d = +mm[3];
  } else if ((mm = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) {
    d = +mm[1]; m = +mm[2]; y = +mm[3];
  } else if ((mm = s.match(/(19|20)\d{2}/))) {
    y = +mm[0]; // year-only DOB
  }
  if (!y) return "";
  const today = new Date();
  let age = today.getFullYear() - y;
  const monthDiff = today.getMonth() + 1 - m; // getMonth() is 0-based
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < d)) {
    age--; // birthday hasn't occurred yet this year
  }
  return age >= 0 && age < 130 ? String(age) : "";
};

// The Aadhaar extractor returns DOB as DD/MM/YYYY, but <input type="date"> ONLY
// renders a value in ISO YYYY-MM-DD. Without this conversion the extracted DOB
// silently disappears from the form. Accepts DD/MM/YYYY, DD-MM-YYYY, or an
// already-ISO string and always returns YYYY-MM-DD (or "" if unparseable).
const toDateInputValue = (dob: string): string => {
  if (!dob) return "";
  const s = dob.trim();
  // Already ISO (YYYY-MM-DD)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // DD/MM/YYYY or DD-MM-YYYY
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
};

// The 11 party fields shared by an executant and a claimant row (everything except id).
interface AadhaarRowData {
  name: string; relation: string; occupation: string; cellNo: string;
  aadhaarNo: string; age: string; dob: string; address: string;
  district: string; state: string; pincode: string;
}

// Clean address to ensure no S/O, W/O, D/O, C/O prefix or relation name is included in residential address
const cleanAddressWithoutRelation = (address: string, relation?: string): string => {
  if (!address) return "";
  let cleaned = address.trim();

  // 1. Remove prefixes like "S/O: John Doe,", "W/O Jane Doe,", "D/O: ...", "C/O: ..."
  cleaned = cleaned.replace(/^(?:S\/[Oo]|W\/[Oo]|D\/[Oo]|C\/[Oo]|Care\s+of|Son\s+of|Wife\s+of|Daughter\s+of)\s*:?\s*[^,.\n\d]+[,.\n]?\s*/i, "");

  // 2. If a specific relation name is given, strip that relation name if present
  if (relation && relation.trim()) {
    const rel = relation.trim();
    const nameOnly = rel.replace(/^(?:S\/[Oo]|W\/[Oo]|D\/[Oo]|C\/[Oo]|Care\s+of|Son\s+of|Wife\s+of|Daughter\s+of)\s*:?\s*/i, "").trim();
    if (nameOnly.length > 2) {
      const esc = nameOnly.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(`(?:S\\/[Oo]|W\\/[Oo]|D\\/[Oo]|C\\/[Oo])?\\s*:?\\s*${esc}[,\\.\\s]*`, "gi"), "");
    }
  }

  // 3. Clean leading or trailing punctuation or symbols
  cleaned = cleaned.replace(/^[\s,.:\-]+|[\s,.:\-]+$/g, "").trim();
  return cleaned;
};

// Turn a raw /api/extract-aadhaar payload into a normalized row: DOB coerced to the
// ISO value the date input needs, and age computed from DOB when the card omits it.
const normalizeAadhaarPayload = (data: any): AadhaarRowData => {
  const dob = toDateInputValue(data?.dob || "");
  // Prefer computing age from DOB (month/day-aware) over the model's own figure,
  // which is year-subtraction only and overshoots by 1 before the birthday. Use
  // the RAW extracted dob (not the ISO input value) so year-only cards — where
  // toDateInputValue() returns "" — still yield an age. Fall back to the model's
  // age only when the card has no readable DOB at all.
  const age = calculateAgeFromDOB(data?.dob || dob) || (data?.age ? String(data.age) : "");
  const relation = data?.relation || "";
  const rawAddr = data?.address || "";
  const address = cleanAddressWithoutRelation(rawAddr, relation);
  return {
    name: data?.name || "",
    relation,
    occupation: data?.occupation || "",
    cellNo: data?.mobile || "",
    aadhaarNo: data?.aadhaarNo || "",
    age: age || "",
    dob,
    address,
    district: data?.district || "",
    state: data?.state || "",
    pincode: data?.pincode || "",
  };
};

const SQUARE_METRES_PER_SQUARE_YARD = 0.83612736;

// Link documents can state the area in square metres, which must remain exactly
// as extracted. When the user types an area in square yards, convert that input
// deterministically rather than retaining a stale extracted/manual metres value.
const squareYardsToSquareMetres = (value: string): string => {
  const numeric = String(value || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!numeric) return "";
  const squareYards = Number(numeric[0]);
  if (!Number.isFinite(squareYards)) return "";
  return (squareYards * SQUARE_METRES_PER_SQUARE_YARD)
    .toFixed(4)
    .replace(/\.?(0+)$/, "");
};

// Store currency values in the Indian grouping style everywhere they are shown:
// 5000000 becomes 50,00,000. Supports optional paise without treating an empty
// field as zero, so the user can still clear and replace a value naturally.
const formatIndianCurrency = (value: string): string => {
  const normalized = String(value || "")
    .replace(/[₹,\s]/g, "")
    .replace(/^rs\.?/i, "")
    .replace(/\/-$/, "")
    .trim();
  if (!normalized || !/^\d*(?:\.\d{0,2})?$/.test(normalized)) return "";
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return "";
  const fractionDigits = normalized.includes(".")
    ? Math.min(2, (normalized.split(".")[1] || "").length)
    : 0;
  return amount.toLocaleString("en-IN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: 2,
  });
};

// An Aadhaar card's FRONT (name, DOB, photo, number) and BACK (relation, address)
// carry DISJOINT fields but share the SAME 12-digit number. Uploading each side
// used to create two half-empty rows. This merges a newly extracted side into the
// matching existing row (matched by Aadhaar number, or — when a side's number is
// unreadable — into the most recent complementary half), filling only blank fields
// so nothing already entered is overwritten. Falls back to appending a new row.
function mergeAadhaar<T extends AadhaarRowData & { id: string }>(
  prev: T[],
  incoming: AadhaarRowData,
  makeId: () => string
): { rows: T[]; index: number; merged: boolean } {
  const digits = (s: string) => (s || "").replace(/\D/g, "");
  const inNum = digits(incoming.aadhaarNo);

  // Primary match: same Aadhaar number already present.
  let idx = inNum ? prev.findIndex((r) => digits(r.aadhaarNo) === inNum) : -1;

  // Fallback (number unreadable on this side): merge into the most recent row that
  // is the complementary half — one has a name but no address, the other vice-versa.
  if (idx < 0 && !inNum) {
    for (let i = prev.length - 1; i >= 0; i--) {
      const r = prev[i];
      const complementary =
        (!!r.name && !r.address && !!incoming.address && !incoming.name) ||
        (!!r.address && !r.name && !!incoming.name && !incoming.address);
      if (complementary) { idx = i; break; }
    }
  }

  if (idx >= 0) {
    // Prefer the just-uploaded (incoming) value over the previously-stored one whenever the
    // new extraction actually returned something for that field. This lets a re-upload (e.g.
    // a clearer photo of the same card, or a corrected scan) fix a wrong/stale value such as
    // pincode instead of being silently ignored. Only fall back to the old value when the new
    // side genuinely has nothing for that field (e.g. the front side has no address/pincode).
    const cur = prev[idx];
    const rel = incoming.relation || cur.relation;
    const addr = cleanAddressWithoutRelation(incoming.address || cur.address, rel);
    const filled: T = {
      ...cur,
      name: incoming.name || cur.name,
      relation: rel,
      occupation: incoming.occupation || cur.occupation,
      cellNo: incoming.cellNo || cur.cellNo,
      aadhaarNo: incoming.aadhaarNo || cur.aadhaarNo,
      age: incoming.age || cur.age,
      dob: incoming.dob || cur.dob,
      address: addr,
      district: incoming.district || cur.district,
      state: incoming.state || cur.state,
      pincode: incoming.pincode || cur.pincode,
    };
    const rows = [...prev];
    rows[idx] = filled;
    return { rows, index: idx, merged: true };
  }

  const rows = [...prev, { id: makeId(), ...incoming } as T];
  return { rows, index: rows.length - 1, merged: false };
}

// ---- Step 7 A4 pagination geometry ----------------------------------------
// The on-screen preview mirrors the server .docx spec EXACTLY so what you see is
// what prints: A4 (210×297mm), Times New Roman 14pt / 1.5 line-height, 0.75in
// side + 1in bottom margins. PAGE 1 reserves 5.8in at the top for the pre-printed
// stamp logo/header; pages 2..n use the normal 1in top margin (NO blank reserve).
// CSS uses the reference pixel: 1in = 96px, so screen px == print geometry.
const PX_PER_IN = 96;
const PX_PER_MM = 96 / 25.4;
const A4_WIDTH_PX = 210 * PX_PER_MM; // ≈ 793.7
const A4_HEIGHT_PX = 297 * PX_PER_MM; // ≈ 1122.5
const DEED_SIDE_MARGIN_IN = 0.75;
const DEED_TOP_MARGIN_IN = 1;
const DEED_BOTTOM_MARGIN_IN = 1;
const DEED_STAMP_RESERVE_IN = 5.8; // page-1 only
const DEED_CONTENT_WIDTH_PX = A4_WIDTH_PX - 2 * DEED_SIDE_MARGIN_IN * PX_PER_IN; // ≈ 649.7
const PAGE1_CONTENT_HEIGHT_PX = A4_HEIGHT_PX - (DEED_STAMP_RESERVE_IN + DEED_BOTTOM_MARGIN_IN) * PX_PER_IN; // ≈ 469.7
const PAGEN_CONTENT_HEIGHT_PX = A4_HEIGHT_PX - (DEED_TOP_MARGIN_IN + DEED_BOTTOM_MARGIN_IN) * PX_PER_IN; // ≈ 930.5
const DEED_FONT_FAMILY = "'Times New Roman', Times, serif";
const DEED_FONT_SIZE_PT = 14;
const DEED_LINE_HEIGHT = 1.5;
const isPageBreakLine = (s: string) => /^-{2,}\s*PAGE\s*BREAK\s*-{2,}$/i.test((s || "").trim());

// Shared text-flow style so the hidden measurer and the rendered page wrap identically.
const DEED_TEXT_STYLE: React.CSSProperties = {
  fontFamily: DEED_FONT_FAMILY,
  fontSize: `${DEED_FONT_SIZE_PT}pt`,
  lineHeight: DEED_LINE_HEIGHT,
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  wordBreak: "break-word",
  color: "#000",
};

// Split the deed text into A4 pages. Honours explicit "---PAGE BREAK---" markers as
// hard breaks and auto-flows the rest, using per-line heights measured in `measurer`
// (which must already be sized to DEED_CONTENT_WIDTH_PX with DEED_TEXT_STYLE). Page 1
// holds less because of the 5.8in stamp reserve.
function paginateDeedText(text: string, measurer: HTMLElement): string[] {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  measurer.innerHTML = "";
  const nodes = lines.map((ln) => {
    const d = document.createElement("div");
    d.textContent = ln.length ? ln : " "; // nbsp keeps blank lines one line tall
    measurer.appendChild(d);
    return d;
  });
  const heights = nodes.map((n) => n.offsetHeight || 0);
  measurer.innerHTML = "";

  const pages: string[] = [];
  let cur: string[] = [];
  let curH = 0;
  let pageNum = 0;
  const avail = () => (pageNum === 0 ? PAGE1_CONTENT_HEIGHT_PX : PAGEN_CONTENT_HEIGHT_PX);
  for (let i = 0; i < lines.length; i++) {
    if (isPageBreakLine(lines[i])) {
      pages.push(cur.join("\n"));
      cur = []; curH = 0; pageNum++;
      continue;
    }
    const h = heights[i];
    if (cur.length > 0 && curH + h > avail()) {
      pages.push(cur.join("\n"));
      cur = []; curH = 0; pageNum++;
    }
    cur.push(lines[i]);
    curH += h;
  }
  pages.push(cur.join("\n"));
  return pages.length ? pages : [""];
}

export default function App() {
  // Which workflow the user is running. Two entirely separate flows that must NOT
  // be mixed:
  //   "generate" — the original 8-step Deed Document & Plan Generation flow.
  //   "verify"   — a 3-step flow that checks an already-generated deed document
  //                against the Step-1 registration details + uploaded Aadhaar/link
  //                documents. Reuses Step 1's form and the generate flow's
  //                verification logic verbatim; only the step COUNT and the middle
  //                step (upload the finished document) differ.
  const [flowMode, setFlowMode] = useState<"generate" | "verify">("generate");
  // 8-Step (generate) / 3-Step (verify) Wizard State
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [registrationDate, setRegistrationDate] = useState(new Date().toISOString().split('T')[0]);

  // Step 1: Property Verification Metadata
  const [propertyDistrict, setPropertyDistrict] = useState("");
  const [propertyMandal, setPropertyMandal] = useState("");
  const [propertyVillage, setPropertyVillage] = useState("");
  const [propertySurvey, setPropertySurvey] = useState("");
  const [propertyHNo, setPropertyHNo] = useState("");
  const [propertyPlotNo, setPropertyPlotNo] = useState("");
  const [propertyPTINo, setPropertyPTINo] = useState("");
  const [propertyExtent, setPropertyExtent] = useState("");
  const [propertyPlinth, setPropertyPlinth] = useState("");
  const [boundaryEast, setBoundaryEast] = useState("");
  const [boundaryWest, setBoundaryWest] = useState("");
  const [boundaryNorth, setBoundaryNorth] = useState("");
  const [boundarySouth, setBoundarySouth] = useState("");

  // Step 2: Executant & Claimant Identity entry
  const [executantName, setExecutantName] = useState("");
  const [executantRelation, setExecutantRelation] = useState("");
  const [executantAge, setExecutantAge] = useState(0);
  const [executantAadhaar, setExecutantAadhaar] = useState("");
  const [executantPan, setExecutantPan] = useState("");
  const [executantDOB, setExecutantDOB] = useState("");
  const [executantAddress, setExecutantAddress] = useState("");

  const [claimantName, setClaimantName] = useState("");
  const [claimantRelation, setClaimantRelation] = useState("");
  const [claimantAge, setClaimantAge] = useState(0);
  const [claimantAadhaar, setClaimantAadhaar] = useState("");
  const [claimantPan, setClaimantPan] = useState("");
  const [claimantDOB, setClaimantDOB] = useState("");
  const [claimantAddress, setClaimantAddress] = useState("");

  // Step 3 (Inserted): Property Transaction Details Form (Bilingual Official Template)
  const [marketValue, setMarketValue] = useState("");
  const [stampsAmount, setStampsAmount] = useState("");
  const [natureOfTransaction, setNatureOfTransaction] = useState("");

  // NEW: Property Type selector
  const [propertyType, setPropertyType] = useState<"" | "Open plot" | "House" | "Demolished House" | "Part of open place" | "Flat">("");

  // NEW: Loading states for uploads
  const [uploadingAadhaarExecutant, setUploadingAadhaarExecutant] = useState(false);
  const [uploadingAadhaarClaimant, setUploadingAadhaarClaimant] = useState(false);
  const [uploadingLinkDocument, setUploadingLinkDocument] = useState(false);

  // Edit mode states for each section
  const [editingExecutants, setEditingExecutants] = useState(false);
  const [editingClaimants, setEditingClaimants] = useState(false);
  const [editingJurisdiction, setEditingJurisdiction] = useState(false);
  const [editingLinkDocuments, setEditingLinkDocuments] = useState(false);
  const [editingProperties, setEditingProperties] = useState(false);
  const [editingBoundaries, setEditingBoundaries] = useState(false);

  // NEW: House Tax Receipt field for Link Document Details
  const [linkHouseTaxReceipt, setLinkHouseTaxReceipt] = useState("");

  interface ExecutantRow {
    id: string;
    name: string;
    relation: string;
    occupation: string;
    cellNo: string;
    aadhaarNo: string;
    age: string;
    dob: string;
    address: string;
    district: string;
    state: string;
    pincode: string;
  }

  interface ClaimantRow {
    id: string;
    name: string;
    relation: string;
    occupation: string;
    cellNo: string;
    aadhaarNo: string;
    age: string;
    dob: string;
    address: string;
    district: string;
    state: string;
    pincode: string;
  }

  interface LinkDocumentRow {
    id: string;
    layoutFileNo: string;
    linkDocType: string;
    linkDocNo: string;
    linkDocDate: string;
    subRegistrar: string;
    subRegistrarCode: string;
    pattadarPassbookNo: string;
    passbookKhataNo: string;
    nalaOrderNo: string;
    houseTaxReceipt: string;
  }

  interface PropertyRow {
    id: string;
    propertyType: "" | "Open plot" | "House" | "Demolished House" | "Part of open place" | "Flat";
    plotNo: string;
    extentSqYards: string;
    extentSqMeters: string;
    surveyNo: string;
    nearHNo: string;
    adjacentHNo: string;
    locality: string;
    pincode: string;
    vltPtiNo: string;
    bltNo: string;
    ptiNo: string;
    marketValuePerSqYard: string;
    marketValueTotal: string;
    // House specific
    houseBearingHNo: string;
    houseNature: string;
    houseFloors: string;
    housePlinthArea: string;
    houseAge: string;
    houseTapConnection: string;
    houseMetersNo: string;
    houseTaxes: string;
    houseRentalValue: string;
    // Demolished House specific
    demoBearingHNo: string;
    demoLocality: string;
    demoTapConnection: string;
    demoMetersNo: string;
    // Part of open place specific
    partBearingHNo: string;
    partLocality: string;
    // Flat specific
    flatNo: string;
    flatUndividedSqYards: string;
    flatUndividedSqMeters: string;
    flatBearingHNo: string;
    flatNature: string;
    flatLocality: string;
    flatValuePerSqFeet: string;
    flatMarketValueTotal: string;
    flatAge: string;
    flatTapConnection: string;
    flatMetersNo: string;
    flatTaxes: string;
    flatRentalValue: string;
    flatBuildingName: string;
    flatNearHNo: string;
    flatFloorS: string;
    flatPlinthArea: string;
    flatTotalLand: string;
  }

  interface BoundaryRow {
    id: string;
    east: string;
    west: string;
    north: string;
    south: string;
  }

  interface JurisdictionRow {
    id: string;
    districtRegistrar: string;
    subRegistrar: string;
    district: string;
    mandal: string;
    village: string;
    pincode: string;
  }

  const [executantsList, setExecutantsList] = useState<ExecutantRow[]>([]);

  const [claimantsList, setClaimantsList] = useState<ClaimantRow[]>([]);

  const [linkDocumentsList, setLinkDocumentsList] = useState<LinkDocumentRow[]>([]);

  const [propertiesList, setPropertiesList] = useState<PropertyRow[]>([]);

  const [boundariesList, setBoundariesList] = useState<BoundaryRow[]>([]);

  const [jurisdictionsList, setJurisdictionsList] = useState<JurisdictionRow[]>([]);

  const [jurDistrictRegistrar, setJurDistrictRegistrar] = useState("");
  const [jurSubRegistrar, setJurSubRegistrar] = useState("");
  const [jurDistrict, setJurDistrict] = useState("");
  const [jurMandal, setJurMandal] = useState("");
  const [jurVillage, setJurVillage] = useState("");
  const [jurPincode, setJurPincode] = useState("");

  const [linkDocNo, setLinkDocNo] = useState("");
  const [linkDocDate, setLinkDocDate] = useState("");
  const [linkSubRegistrar, setLinkSubRegistrar] = useState("");
  const [linkSubRegistrarCode, setLinkSubRegistrarCode] = useState("");
  const [linkPattadarPassbook, setLinkPattadarPassbook] = useState("");
  const [linkPassbookKhataNo, setLinkPassbookKhataNo] = useState("");
  const [linkNalaOrderNo, setLinkNalaOrderNo] = useState("");
  const [linkLayoutFileNo, setLinkLayoutFileNo] = useState("");

  const [propertyTypeFilter, setPropertyTypeFilter] = useState<"Open Plot" | "House" | "Demolished House" | "Part of Open Place" | "Flat">("Open Plot");
  const [propPlotNo, setPropPlotNo] = useState("");
  const [propExtentSqYards, setPropExtentSqYards] = useState("");
  const [propExtentSqMeters, setPropExtentSqMeters] = useState("");
  const [propSurveyNo, setPropSurveyNo] = useState("");
  const [propNearHNo, setPropNearHNo] = useState("");
  const [propAdjacentHNo, setPropAdjacentHNo] = useState("");
  const [propLocality, setPropLocality] = useState("");
  const [propPincode, setPropPincode] = useState("");
  const [propVltPtiNo, setPropVltPtiNo] = useState("");
  const [propMarketValuePerSqYard, setPropMarketValuePerSqYard] = useState("");
  const [propMarketValueTotal, setPropMarketValueTotal] = useState("");
  const [autoAdjustBlanks, setAutoAdjustBlanks] = useState(true);

  // Additional Property fields for House, Demolished House, Part of Open Place, Flat from the PDF
  const [propHouseNature, setPropHouseNature] = useState("");
  const [propHouseFloors, setPropHouseFloors] = useState("");
  const [propHouseAge, setPropHouseAge] = useState("");
  const [propHouseTapConnection, setPropHouseTapConnection] = useState("");
  const [propHouseMetersNo, setPropHouseMetersNo] = useState("");
  const [propHouseTaxes, setPropHouseTaxes] = useState("");
  const [propHouseRentalValue, setPropHouseRentalValue] = useState("");

  const [propDemoBearingHNo, setPropDemoBearingHNo] = useState("");
  const [propDemoLocality, setPropDemoLocality] = useState("");
  const [propDemoTapConnection, setPropDemoTapConnection] = useState("");
  const [propDemoMetersNo, setPropDemoMetersNo] = useState("");

  const [propPartBearingHNo, setPropPartBearingHNo] = useState("");
  const [propPartLocality, setPropPartLocality] = useState("");

  const [propFlatNo, setPropFlatNo] = useState("");
  const [propFlatUndividedSqYards, setPropFlatUndividedSqYards] = useState("");
  const [propFlatUndividedSqMeters, setPropFlatUndividedSqMeters] = useState("");
  const [propFlatBearingHNo, setPropFlatBearingHNo] = useState("");
  const [propFlatNature, setPropFlatNature] = useState("");
  const [propFlatLocality, setPropFlatLocality] = useState("");
  const [propFlatValuePerSqFeet, setPropFlatValuePerSqFeet] = useState("");
  const [propFlatMarketValueTotal, setPropFlatMarketValueTotal] = useState("");
  const [propFlatAge, setPropFlatAge] = useState("");
  const [propFlatTapConnection, setPropFlatTapConnection] = useState("");
  const [propFlatMetersNo, setPropFlatMetersNo] = useState("");
  const [propFlatTaxes, setPropFlatTaxes] = useState("");
  const [propFlatRentalValue, setPropFlatRentalValue] = useState("");
  const [propFlatBuildingName, setPropFlatBuildingName] = useState("");
  const [propFlatNearHNo, setPropFlatNearHNo] = useState("");
  const [propFlatFloorS, setPropFlatFloorS] = useState("");
  const [propFlatPlinthArea, setPropFlatPlinthArea] = useState("");
  const [propFlatTotalLand, setPropFlatTotalLand] = useState("");

  // Sync basic state to rich registration form states when basic state changes
  useEffect(() => {
    setJurDistrict(propertyDistrict);
    setJurDistrictRegistrar(propertyDistrict);
    setJurMandal(propertyMandal);
    setJurSubRegistrar(propertyMandal);
    setJurVillage(propertyVillage);
    setPropSurveyNo(propertySurvey);
    setPropPlotNo(propertyPlotNo);
    setPropNearHNo(propertyHNo);
    setPropExtentSqYards(propertyExtent);
  }, [propertyDistrict, propertyMandal, propertyVillage, propertySurvey, propertyHNo, propertyPlotNo, propertyExtent]);

  useEffect(() => {
    setExecutantsList(prev => {
      const updated = [...prev];
      if (updated[0]) {
        if (
          updated[0].name !== executantName ||
          updated[0].relation !== executantRelation ||
          updated[0].age !== String(executantAge) ||
          updated[0].aadhaarNo !== executantAadhaar ||
          updated[0].dob !== executantDOB ||
          updated[0].address !== executantAddress
        ) {
          updated[0] = {
            ...updated[0],
            name: executantName,
            relation: executantRelation,
            age: String(executantAge),
            aadhaarNo: executantAadhaar,
            dob: executantDOB,
            address: executantAddress
          };
          return updated;
        }
      }
      return prev;
    });
  }, [executantName, executantRelation, executantAge, executantAadhaar, executantDOB, executantAddress]);

  useEffect(() => {
    setClaimantsList(prev => {
      const updated = [...prev];
      if (updated[0]) {
        if (
          updated[0].name !== claimantName ||
          updated[0].relation !== claimantRelation ||
          updated[0].age !== String(claimantAge) ||
          updated[0].aadhaarNo !== claimantAadhaar ||
          updated[0].dob !== claimantDOB ||
          updated[0].address !== claimantAddress
        ) {
          updated[0] = {
            ...updated[0],
            name: claimantName,
            relation: claimantRelation,
            age: String(claimantAge),
            aadhaarNo: claimantAadhaar,
            dob: claimantDOB,
            address: claimantAddress
          };
          return updated;
        }
      }
      return prev;
    });
  }, [claimantName, claimantRelation, claimantAge, claimantAadhaar, claimantDOB, claimantAddress]);

  // Warn before page refresh/close if form has been modified
  useEffect(() => {
    const hasFormData =
      marketValue !== "" ||
      stampsAmount !== "" ||
      executantsList.some(e => e.name !== "" || e.aadhaarNo !== "" || e.address !== "") ||
      claimantsList.some(c => c.name !== "" || c.aadhaarNo !== "" || c.address !== "") ||
      jurDistrict !== "" ||
      jurVillage !== "" ||
      linkDocNo !== "" ||
      propPlotNo !== "" ||
      propSurveyNo !== "";

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasFormData) {
        e.preventDefault();
        e.returnValue = "You have unsaved changes. Are you sure you want to leave?";
        return e.returnValue;
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [
    marketValue,
    stampsAmount,
    executantsList,
    claimantsList,
    jurDistrict,
    jurVillage,
    linkDocNo,
    propPlotNo,
    propSurveyNo
  ]);

  // Step 3: File Upload states (Identity & Link Deeds)
  const [aadhaarCards, setAadhaarCards] = useState<MockFile[]>([]);
  const [linkDocuments, setLinkDocuments] = useState<MockFile[]>([]);

  // VERIFY FLOW — Step 2: the already-generated/updated deed document the user
  // uploads to be checked. Only .docx/.doc are accepted; the parsed text is loaded
  // into `filledDeedText` (the SAME variable the verification audit reads) so the
  // verify flow's Step 3 reuses the generate flow's audit logic unchanged.
  const [verifyDocName, setVerifyDocName] = useState<string>("");
  const [verifyDocParsing, setVerifyDocParsing] = useState(false);
  // VERIFY FLOW — Step 3: zoom for the Word-style report page, and per-button
  // "downloading" state for the two export actions.
  const [reportZoom, setReportZoom] = useState(1);
  const [reportDownloading, setReportDownloading] = useState<"" | "report" | "corrected">("");

  // Step 4: AI Extraction State
  const [extractedDetails, setExtractedDetails] = useState<any>(null);
  const [extracting, setExtracting] = useState(false);

  // Step 5: Selected Model Template
  const [selectedModelId, setSelectedModelId] = useState<string>("custom-uploaded");
  const [customModelText, setCustomModelText] = useState(
    MODEL_TEMPLATES.find(t => t.id === "residential-plot")?.templateText || ""
  );

  // Step 3 (new flow): predefined Word (.docx) template library
  interface ServerTemplate {
    id: string;
    name: string;
    description: string;
    registrationTypes: string[];
    file: string;
    isSeed?: boolean;
  }
  const [serverTemplates, setServerTemplates] = useState<ServerTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  // Step 3: user-supplied ("bring your own") .docx/.doc/.txt template. When present and
  // selected (selectedTemplateId === CUSTOM_TEMPLATE_ID), Step 4 merges the extracted
  // details into THIS document's wording instead of a library template.
  const [customTemplateText, setCustomTemplateText] = useState<string>("");
  const [customTemplateName, setCustomTemplateName] = useState<string>("");
  const [customTemplateLoading, setCustomTemplateLoading] = useState(false);
  // When the uploaded template is a .docx, keep its ORIGINAL bytes (base64) so the
  // server can fill the <markers> in place and preserve the template's exact
  // formatting (fonts, bold, sizes, margins, alignment) instead of rebuilding it.
  const [customTemplateDocxBase64, setCustomTemplateDocxBase64] = useState<string>("");

  // Step 6: Auto-Filled Deed draft text
  const [filledDeedText, setFilledDeedText] = useState("");
  const [filling, setFilling] = useState(false);
  // Step 6 paginated Word-style preview
  const [deedPages, setDeedPages] = useState<string[]>([]);
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  const [previewEditing, setPreviewEditing] = useState(false);
  const [previewScale, setPreviewScale] = useState(1);
  const deedMeasureRef = useRef<HTMLDivElement | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);
  // Set true when docx-preview cannot render the filled .docx bytes; both the
  // Auto-Fill Draft (Step 4) and Stamp Preview (Step 7) then fall back to their
  // text views. Reset to false whenever new bytes are generated. The actual
  // rendering/measuring/scaling lives in the shared <DocxLivePreview> component.
  const [docxPreviewError, setDocxPreviewError] = useState(false);
  // Generated document artifacts (from server /api/generate-document)
  const [generatedDocxBase64, setGeneratedDocxBase64] = useState<string>("");
  const [unresolvedPlaceholders, setUnresolvedPlaceholders] = useState<string[]>([]);
  const [mergeMode, setMergeMode] = useState<string>("");
  const [exporting, setExporting] = useState<"" | "docx" | "pdf">("");

  // Step 7: Audit Report & Verification State
  const [report, setReport] = useState<any | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditStepIndex, setAuditStepIndex] = useState(0);

  // Step 3 "Re-Audit" (Feature #4): cross-checks the entered Step 1/2 data
  // against the uploaded Aadhaar/link documents BEFORE the draft is auto-filled
  // in Step 4. Kept separate from `report` (the post-draft Step 5 audit) since
  // they check different things and can both be open/stale at once.
  const [preAuditReport, setPreAuditReport] = useState<any | null>(null);
  const [preAuditing, setPreAuditing] = useState(false);

  // Step 4 "Translate to Telugu" (Feature #5): on-demand translation of the
  // generated deed into a SEPARATE, standalone .docx set in the Sree
  // Krushnadevaraya Telugu font. Kept apart from filledDeedText/generatedDocxBase64
  // (the English draft) since this is an additional artifact, not a replacement.
  const [teluguTranslating, setTeluguTranslating] = useState(false);
  const [teluguDocxBase64, setTeluguDocxBase64] = useState<string>("");

  // Generate Plan Feature State
  const [sketchImage, setSketchImage] = useState<string | null>(null);
  const [sketchFileName, setSketchFileName] = useState<string>("");
  const [planCustomPrompt, setPlanCustomPrompt] = useState<string>("");
  const [generatedPlanImage, setGeneratedPlanImage] = useState<string | null>(null);
  const [planGenerating, setPlanGenerating] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planMasterPrompt, setPlanMasterPrompt] = useState<string>("");
  const [planVerificationReport, setPlanVerificationReport] = useState<any | null>(null);
  // Structured plan JSON (sketch extraction result) behind the currently-shown
  // generatedPlanImage. Kept so the "Editable Plan (Word)" export can hand the
  // server the SAME data the image was rendered from, rather than re-deriving
  // it — the native-shapes docx renderer computes identical geometry from this.
  const [extractedPlan, setExtractedPlan] = useState<any | null>(null);
  const [exportingEditablePlan, setExportingEditablePlan] = useState(false);
  // Fullscreen expand/preview of the generated plan (with inline prompt refine).
  const [planExpanded, setPlanExpanded] = useState(false);
  // Sequence counter for /api/generate-plan calls — see handleGeneratePlan's
  // race-guard comment. Prevents an in-flight, now-stale request's response
  // from clobbering a NEWER request's result when the two overlap.
  const planRequestSeqRef = useRef(0);

  // General App states
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The STRUCTURED failure behind `error`. `error` is a bare string with no code
  // and no retryability, so it cannot drive per-cause guidance (a 429 needs
  // billing, a 504 needs a retry) — and it was rendered nowhere at all. Keep
  // both in step: setFailure for anything the user must see.
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  // A step that SUCCEEDED but without AI. Separate from `failure` because it is
  // informational, not blocking, and must not read as an error.
  const [degraded, setDegraded] = useState<ApiFailure | null>(null);
  // Set alongside setFailure so a banner can offer a working Retry button.
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPresetsExpanded, setIsPresetsExpanded] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<any[]>([]);
  // Identity of the saved-draft record the CURRENT session is editing, if any.
  // Set when a draft is resumed (loadDraftFromRegistry) or after the first
  // successful save. As long as this points at a record that still exists,
  // saveDraftToRegistry() UPDATES that record in place instead of prepending a
  // brand-new one — this is what stops "Save Draft" from piling up duplicate
  // entries every time it's clicked for what is really the same deed. Cleared
  // whenever the user starts a genuinely different deed (preset load) or
  // deletes the record it points to.
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [isDraftsExpanded, setIsDraftsExpanded] = useState(false);
  const [activeAuditTab, setActiveAuditTab] = useState<"all" | "critical" | "warnings">("all");

  // ---- AI failure reporting helpers -------------------------------------
  // Single funnel so `error` (legacy string, used by a few inline messages) and
  // `failure` (structured, drives the banner) can never disagree.

  /** Report a blocking failure: the step did not happen. */
  const reportFailure = (err: unknown, label: string, retry?: () => void) => {
    const f = toApiFailure(err, label);
    console.error(`[${label}]`, err);
    setFailure(f);
    setError(f.message);
    setRetryAction(retry ?? null);
    return f;
  };

  /** Clear all AI status before starting a fresh attempt. */
  const clearAiStatus = () => {
    setFailure(null);
    setDegraded(null);
    setError(null);
    setRetryAction(null);
  };

  /**
   * Inspect a 200 response for the server's degradation flags. Returns true when
   * the result came from a fallback, so callers can also adjust their own UI.
   */
  const noteDegradation = (body: any, label: string): boolean => {
    const d = degradedFailure(body, label);
    setDegraded(d);
    return !!d;
  };

  /** Throw a structured ApiFailure for a non-2xx response. */
  const failOn = async (response: Response, label: string): Promise<never> => {
    throw await parseApiFailure(response, label);
  };

  // The 8-step Deed Document & Plan Generation flow.
  const generateWorkflowSteps = [
    { number: 1, title: "Registration Form", telugu: "రిజిస్ట్రేషన్ ఫారమ్", desc: "Official details, values & uploads" },
    { number: 2, title: "Review Details", telugu: "వివరాల సమీక్ష", desc: "Preview all extracted data" },
    { number: 3, title: "Select Template", telugu: "మోడల్ సేల్ డీడ్", desc: "Choose Word deed template" },
    { number: 4, title: "Auto-Fill Draft", telugu: "డీడ్ తయారీ", desc: "Merge details into template" },
    { number: 5, title: "Re-Verify Deed", telugu: "సరిపోలిక తనిఖీ", desc: "Deep audit for errors" },
    { number: 6, title: "Generate Plan", telugu: "ప్లాన్ జనరేషన్", desc: "Convert hand sketch to CAD AI image" },
    { number: 7, title: "Stamp Preview", telugu: "రిజిస్ట్రేషన్ ప్రివ్యూ", desc: "A4 stamp-paper preview" },
    { number: 8, title: "Download & Print", telugu: "డౌన్‌లోడ్ & ప్రింట్", desc: "Export Word/PDF & print" }
  ];

  // The 3-step Verify the Deed Document flow. Step 1 reuses the exact registration
  // form; Step 3 reuses the exact verification audit from the generate flow.
  const verifyWorkflowSteps = [
    { number: 1, title: "Registration Form", telugu: "రిజిస్ట్రేషన్ ఫారమ్", desc: "Official details, values & uploads" },
    { number: 2, title: "Upload Document", telugu: "డాక్యుమెంట్ అప్‌లోడ్", desc: "Upload the generated deed (.docx/.doc)" },
    { number: 3, title: "Verify Details", telugu: "సరిపోలిక తనిఖీ", desc: "Cross-check the document for errors" }
  ];

  const workflowSteps = flowMode === "verify" ? verifyWorkflowSteps : generateWorkflowSteps;
  const totalSteps = workflowSteps.length;

  const auditingStepsLogs = [
    "Reading drafted template and original uploads...",
    "Scanning name spelling character-by-character...",
    "Verifying 12-digit Aadhaar number accuracy...",
    "Calculating rounded age at execution from DOB...",
    "Auditing land survey numbers and boundaries...",
    "Translating bilingual terms and verifying PTI tax codes...",
    "Cross-checking link deed serial reference number...",
    "Compiling report and suggesting repairs..."
  ];

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (auditing) {
      setAuditStepIndex(0);
      interval = setInterval(() => {
        setAuditStepIndex((prev) => {
          if (prev < auditingStepsLogs.length - 1) {
            return prev + 1;
          }
          return prev;
        });
      }, 900);
    }
    return () => clearInterval(interval);
  }, [auditing]);

  // Load standard scenario presets and load stored history
  useEffect(() => {
    // Don't load any preset by default - start with empty form
    // handleSelectPreset(PRESETS[0]); // Commented out - presets only loaded when user clicks them

    // Load local storage registry
    const stored = localStorage.getItem("telangana_deeds_registry");
    if (stored) {
      try {
        setSavedDrafts(JSON.parse(stored));
      } catch (err) {
        console.error("Failed to parse registry history:", err);
      }
    }
  }, []);

  // Preset Selector Loader
  const handleSelectPreset = async (preset: Preset) => {
    // A preset loads a distinct sample deed — it must not be treated as "the
    // same deed" as whatever was previously saved/resumed in this session, so
    // the next Save Draft creates its own new entry rather than overwriting
    // an unrelated one.
    setCurrentDraftId(null);
    setActivePresetId(preset.id);
    setRegistrationDate(preset.registrationDate);
    
    // Extrapolate from preset
    setAadhaarCards(preset.aadhaarCards);
    setLinkDocuments(preset.linkDocuments);
    setFilledDeedText(preset.draftText);
    
    // Parse heuristic details to prefill Step 1 and Step 2
    if (preset.id === "perfect-match") {
      // Step 1 Perfect Match
      setPropertyDistrict("Nalgonda");
      setPropertyMandal("Nakrekal");
      setPropertyVillage("Nakrekal");
      setPropertySurvey("412/A");
      setPropertyHNo("4-12");
      setPropertyPlotNo("12");
      setPropertyPTINo("1092003412");
      setPropertyExtent("240 Sq Yards");
      setPropertyPlinth("1500 Sq Ft");
      setBoundaryEast("Canal");
      setBoundaryWest("Ramulu's Land");
      setBoundaryNorth("Main Road");
      setBoundarySouth("Venkataiah's Land");

      // Step 2 Perfect Match
      setExecutantName("Ankem Srinivas");
      setExecutantRelation("S/o Ankem Ramulu");
      setExecutantAge(51);
      setExecutantAadhaar("4521 8902 3412");
      setExecutantPan("ABCDE1234F");
      setExecutantDOB("1975-06-12");
      setExecutantAddress("H.No 4-12, Near Hanuman Temple, Nakrekal Village, Nakrekal Mandal, Nalgonda District, Telangana - 508211");

      setClaimantName("Ganta Venkat Reddy");
      setClaimantRelation("S/o Ganta Malla Reddy");
      setClaimantAge(45);
      setClaimantAadhaar("9876 5432 1098");
      setClaimantPan("XYZWP9876Z");
      setClaimantDOB("1981-08-15");
      setClaimantAddress("Plot No 22, Jubilee Hills, Hyderabad, Telangana - 500033");

      setSelectedModelId("residential-plot");
    } else if (preset.id === "warangal-mismatch") {
      // Step 1 Mismatch
      setPropertyDistrict("Nalgonda");
      setPropertyMandal("Nakrekal");
      setPropertyVillage("Nakrekal");
      setPropertySurvey("412/A");
      setPropertyHNo("4-12/A");
      setPropertyPlotNo("18");
      setPropertyPTINo("1092003415");
      setPropertyExtent("300 Sq Yards");
      setPropertyPlinth("1800 Sq Ft");
      setBoundaryEast("Canal");
      setBoundaryWest("Ramulu's Land");
      setBoundaryNorth("Main Road");
      setBoundarySouth("Venkataiah's Land");

      // Step 2 Mismatch
      setExecutantName("Ankem Srinivas");
      setExecutantRelation("S/o Ankem Ramulu");
      setExecutantAge(51);
      setExecutantAadhaar("4521 8902 3412");
      setExecutantPan("ABCDE1234F");
      setExecutantDOB("1975-06-12");
      setExecutantAddress("H.No 4-12, Near Hanuman Temple, Nakrekal Village, Nakrekal Mandal, Nalgonda District, Telangana - 508211");

      setClaimantName("Ganta Venkat Reddy");
      setClaimantRelation("S/o Ganta Malla Reddy");
      setClaimantAge(45);
      setClaimantAadhaar("9876 5432 1098");
      setClaimantPan("XYZWP9876Z");
      setClaimantDOB("1981-08-15");
      setClaimantAddress("Plot No 22, Jubilee Hills, Hyderabad, Telangana - 500033");

      setSelectedModelId("custom-uploaded");
      setCustomModelText(MODEL_TEMPLATES.find(t => t.id === "residential-plot")?.templateText || "");
    } else if (preset.id === "telugu-mismatch") {
      // Step 1 Telugu
      setPropertyDistrict("Medak");
      setPropertyMandal("Haveli Ghanpur");
      setPropertyVillage("Haveli Ghanpur");
      setPropertySurvey("102/AA");
      setPropertyHNo("2-104");
      setPropertyPlotNo("55");
      setPropertyPTINo("1088009944");
      setPropertyExtent("2.50 Acres");
      setPropertyPlinth("N/A");
      setBoundaryEast("Ramu's Land (రాము భూమి)");
      setBoundaryWest("Sekhar's Land (శేఖర్ భూమి)");
      setBoundaryNorth("Canal (కాలువ)");
      setBoundarySouth("Pond (చెరువు)");

      // Step 2 Telugu
      setExecutantName("Kethavath Ramulu");
      setExecutantRelation("S/o Kethavath Laxma");
      setExecutantAge(58);
      setExecutantAadhaar("9874 5612 3045");
      setExecutantPan("PLKJH9081A");
      setExecutantDOB("1968-01-01");
      setExecutantAddress("Haveli Ghanpur Village, Medak District, Telangana - 502113");

      setClaimantName("Vangala Sudhakar");
      setClaimantRelation("S/o Vangala Narsaiah");
      setClaimantAge(42);
      setClaimantAadhaar("1234 5678 9012");
      setClaimantPan("CVBNM4561E");
      setClaimantDOB("1984-05-10");
      setClaimantAddress("Plot No 44, NGO Colony, Medak, Telangana");

      setSelectedModelId("custom-uploaded");
      setCustomModelText(MODEL_TEMPLATES.find(t => t.id === "agricultural-land")?.templateText || "");
    }

    setReport(null);
    setExtractedDetails(null);
    setError(null);
  };

  // Convert files helper
  const convertFileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };

  // Upload handlers
  const handleAadhaarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setActivePresetId(null);
    const list = [...aadhaarCards];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const base64 = await convertFileToBase64(file);
        list.push({
          name: file.name,
          size: `${Math.round(file.size / 1024)} KB`,
          mimeType: file.type || "application/pdf",
          base64,
          isMock: false
        });
      } catch (err) {
        console.error(err);
      }
    }
    setAadhaarCards(list);
  };

  const handleLinkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setActivePresetId(null);
    const list = [...linkDocuments];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const base64 = await convertFileToBase64(file);
        list.push({
          name: file.name,
          size: `${Math.round(file.size / 1024)} KB`,
          mimeType: file.type || "application/pdf",
          base64,
          isMock: false
        });
      } catch (err) {
        console.error(err);
      }
    }
    setLinkDocuments(list);
  };

  const handleCustomModelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFilling(true);
    setError(null);
    try {
      if (file.name.endsWith(".docx")) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        if (result && result.value) {
          setCustomModelText(result.value);
          setSelectedModelId("custom-uploaded");
        } else {
          alert("Could not extract text from the .docx file.");
        }
      } else if (file.name.endsWith(".txt")) {
        const text = await file.text();
        setCustomModelText(text);
        setSelectedModelId("custom-uploaded");
      } else if (file.name.endsWith(".doc")) {
        const base64 = await convertFileToBase64(file);
        const response = await fetch("/api/parse-doc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64 })
        });
        if (!response.ok) {
          throw new Error("Failed to parse older .doc file via server");
        }
        const data = await response.json();
        if (data.text) {
          setCustomModelText(data.text);
          setSelectedModelId("custom-uploaded");
        } else {
          alert("Could not extract text from the .doc file.");
        }
      } else {
        alert("Please upload a .docx, .doc, or .txt file.");
      }
    } catch (err) {
      console.error("Error reading custom template file:", err);
      alert("Failed to parse the uploaded file. Please verify the file format.");
    } finally {
      setFilling(false);
    }
  };

  // Switch between the 8-step "generate" flow and the 3-step "verify" flow.
  // Resets progress to Step 1 and clears the per-flow artifacts that would
  // otherwise bleed across (the finished document text, the audit report, and the
  // uploaded-document label) so the two flows stay fully isolated. Step-1 form
  // data (parties, property, uploads) is intentionally kept — it is shared input
  // for both flows.
  const switchFlowMode = (mode: "generate" | "verify") => {
    if (mode === flowMode) return;
    setFlowMode(mode);
    setCurrentStep(1);
    setReport(null);
    setFilledDeedText("");
    setVerifyDocName("");
    clearAiStatus();
    setIsPresetsExpanded(false);
  };

  // VERIFY FLOW — Step 2: parse the uploaded finished deed document into
  // `filledDeedText`. Accepts .docx (mammoth, client-side) and .doc (/api/parse-doc).
  // Mirrors the custom-template upload's parsing exactly; no PDF/AI path.
  const handleVerifyDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".docx") && !lower.endsWith(".doc")) {
      setError("Please upload the generated deed as a Microsoft Word .docx or .doc file.");
      e.target.value = "";
      return;
    }
    setVerifyDocParsing(true);
    setError(null);
    setReport(null);
    try {
      let text = "";
      if (lower.endsWith(".docx")) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result?.value || "";
      } else {
        const base64 = await convertFileToBase64(file);
        const response = await fetch("/api/parse-doc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64 }),
        });
        if (!response.ok) throw new Error("Failed to parse the .doc file via server.");
        const data = await response.json();
        text = data.text || "";
      }
      if (!text.trim()) {
        setError("Could not read any text from that document. Please try a different .docx/.doc file.");
        setVerifyDocName("");
        setFilledDeedText("");
        return;
      }
      setFilledDeedText(text);
      setVerifyDocName(file.name);
    } catch (err) {
      console.error("Error reading verify document:", err);
      setError("Failed to parse the uploaded document. Please ensure it is a valid Word .docx/.doc file.");
      setVerifyDocName("");
      setFilledDeedText("");
    } finally {
      setVerifyDocParsing(false);
      e.target.value = "";
    }
  };

  // NEW: Handle Aadhaar upload for Executants
  const handleAadhaarUploadExecutant = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingAadhaarExecutant(true);
    clearAiStatus();

    try {
      const base64 = await convertFileToBase64(file);

      // Call API to extract Aadhaar details
      const response = await fetch("/api/extract-aadhaar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: {
            name: file.name,
            mimeType: file.type || "application/pdf",
            base64
          }
        })
      });

      if (!response.ok) await failOn(response, "Aadhaar extraction");

      const data = await response.json();
      if (data?.error) throw new Error(data.error);

      // Normalize (DOB -> ISO, age from DOB), then merge front/back of the same
      // Aadhaar into ONE row instead of creating a second half-empty row.
      const incoming = normalizeAadhaarPayload(data);
      let mergedIntoExisting = false;
      setExecutantsList(prev => {
        const { rows, index, merged } = mergeAadhaar<ExecutantRow>(prev, incoming, () => `exec-${Date.now()}`);
        mergedIntoExisting = merged;
        // Keep the legacy single-field state (row 0) in sync so downstream steps see it.
        if (index === 0) {
          const r = rows[0];
          setExecutantName(r.name); setExecutantRelation(r.relation);
          setExecutantAadhaar(r.aadhaarNo); setExecutantDOB(r.dob);
          setExecutantAge(Number(r.age) || 0); setExecutantAddress(r.address);
        }
        return rows;
      });

      // Retain the raw file so the Step-5 verification can cross-check the draft against the source.
      setAadhaarCards(prev => [...prev, {
        name: file.name,
        size: `${Math.round(file.size / 1024)} KB`,
        mimeType: file.type || "application/pdf",
        base64,
        isMock: false,
      }]);
      const who = incoming.name || "this executant";
      alert(
        mergedIntoExisting
          ? `Merged this Aadhaar side into ${who}'s existing entry (front + back combined).`
          : `Aadhaar details extracted successfully for ${who}!`
      );

      // Reset input
      e.target.value = "";
    } catch (err: any) {
      // Was a blocking alert() carrying the raw thrown message. The banner shows
      // the server's classified reason instead, stays on screen while the user
      // types the details in by hand, and does not interrupt the upload flow.
      reportFailure(err, "Aadhaar extraction (executant)");
    } finally {
      setUploadingAadhaarExecutant(false);
    }
  };

  // NEW: Handle Aadhaar upload for Claimants
  const handleAadhaarUploadClaimant = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingAadhaarClaimant(true);
    clearAiStatus();

    try {
      const base64 = await convertFileToBase64(file);

      // Call API to extract Aadhaar details
      const response = await fetch("/api/extract-aadhaar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: {
            name: file.name,
            mimeType: file.type || "application/pdf",
            base64
          }
        })
      });

      if (!response.ok) await failOn(response, "Aadhaar extraction");

      const data = await response.json();
      if (data?.error) throw new Error(data.error);

      // Normalize (DOB -> ISO, age from DOB), then merge front/back of the same
      // Aadhaar into ONE row instead of creating a second half-empty row.
      const incoming = normalizeAadhaarPayload(data);
      let mergedIntoExisting = false;
      setClaimantsList(prev => {
        const { rows, index, merged } = mergeAadhaar<ClaimantRow>(prev, incoming, () => `claim-${Date.now()}`);
        mergedIntoExisting = merged;
        // Keep the legacy single-field state (row 0) in sync so downstream steps see it.
        if (index === 0) {
          const r = rows[0];
          setClaimantName(r.name); setClaimantRelation(r.relation);
          setClaimantAadhaar(r.aadhaarNo); setClaimantDOB(r.dob);
          setClaimantAge(Number(r.age) || 0); setClaimantAddress(r.address);
        }
        return rows;
      });

      // Retain the raw file so the Step-5 verification can cross-check the draft against the source.
      setAadhaarCards(prev => [...prev, {
        name: file.name,
        size: `${Math.round(file.size / 1024)} KB`,
        mimeType: file.type || "application/pdf",
        base64,
        isMock: false,
      }]);
      const who = incoming.name || "this claimant";
      alert(
        mergedIntoExisting
          ? `Merged this Aadhaar side into ${who}'s existing entry (front + back combined).`
          : `Aadhaar details extracted successfully for ${who}!`
      );

      // Reset input
      e.target.value = "";
    } catch (err: any) {
      reportFailure(err, "Aadhaar extraction (claimant)");
    } finally {
      setUploadingAadhaarClaimant(false);
    }
  };

  // NEW: Handle Link Document upload and extraction
  const handleLinkDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingLinkDocument(true);
    clearAiStatus();

    try {
      const base64 = await convertFileToBase64(file);

      // Call API to extract link document details
      const response = await fetch("/api/extract-link-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: {
            name: file.name,
            mimeType: file.type || "application/pdf",
            base64
          },
          propertyType: propertyType
        })
      });

      if (!response.ok) await failOn(response, "Link document extraction");

      const data = await response.json();

      // Update Jurisdiction fields - Fill existing row or create new
      if (data.jurisdiction) {
        setJurisdictionsList(prev => {
          if (prev.length === 0) {
            return [{
              id: `jurisdiction-${Date.now()}`,
              districtRegistrar: data.jurisdiction.districtRegistrar || "",
              subRegistrar: data.jurisdiction.subRegistrar || "",
              district: data.jurisdiction.district || "",
              mandal: data.jurisdiction.mandal || "",
              village: data.jurisdiction.village || "",
              pincode: data.jurisdiction.pincode || ""
            }];
          } else {
            const updated = [...prev];
            updated[0] = {
              ...updated[0],
              districtRegistrar: data.jurisdiction.districtRegistrar || updated[0].districtRegistrar,
              subRegistrar: data.jurisdiction.subRegistrar || updated[0].subRegistrar,
              district: data.jurisdiction.district || updated[0].district,
              mandal: data.jurisdiction.mandal || updated[0].mandal,
              village: data.jurisdiction.village || updated[0].village,
              pincode: data.jurisdiction.pincode || updated[0].pincode
            };
            return updated;
          }
        });
      }

      // Update Link Document Details - Fill existing row or append
      if (data.linkDocument) {
        setLinkDocumentsList(prev => {
          if (prev.length === 0) {
            return [{
              id: `linkdoc-${Date.now()}`,
              layoutFileNo: data.linkDocument.layoutFileNo || "",
              linkDocType: data.linkDocument.docType || "",
              linkDocNo: data.linkDocument.docNo || "",
              linkDocDate: data.linkDocument.docDate || data.linkDocument.linkDocDate || "",
              subRegistrar: data.linkDocument.subRegistrar || "",
              subRegistrarCode: data.linkDocument.subRegistrarCode || "",
              pattadarPassbookNo: data.linkDocument.pattadarPassbook || "",
              passbookKhataNo: data.linkDocument.passbookKhataNo || data.linkDocument.khataNo || "",
              nalaOrderNo: data.linkDocument.nalaOrderNo || "",
              houseTaxReceipt: data.linkDocument.houseTaxReceipt || ""
            }];
          } else {
            const first = prev[0];
            if (!first.linkDocNo && !first.linkDocDate && !first.layoutFileNo) {
              const updated = [...prev];
              updated[0] = {
                ...first,
                layoutFileNo: data.linkDocument.layoutFileNo || first.layoutFileNo,
                linkDocType: data.linkDocument.docType || first.linkDocType,
                linkDocNo: data.linkDocument.docNo || first.linkDocNo,
                linkDocDate: data.linkDocument.docDate || data.linkDocument.linkDocDate || first.linkDocDate,
                subRegistrar: data.linkDocument.subRegistrar || first.subRegistrar,
                subRegistrarCode: data.linkDocument.subRegistrarCode || first.subRegistrarCode,
                pattadarPassbookNo: data.linkDocument.pattadarPassbook || first.pattadarPassbookNo,
                passbookKhataNo: data.linkDocument.passbookKhataNo || data.linkDocument.khataNo || first.passbookKhataNo,
                nalaOrderNo: data.linkDocument.nalaOrderNo || first.nalaOrderNo,
                houseTaxReceipt: data.linkDocument.houseTaxReceipt || first.houseTaxReceipt
              };
              return updated;
            } else {
              return [...prev, {
                id: `linkdoc-${Date.now()}`,
                layoutFileNo: data.linkDocument.layoutFileNo || "",
                linkDocType: data.linkDocument.docType || "",
                linkDocNo: data.linkDocument.docNo || "",
                linkDocDate: data.linkDocument.docDate || data.linkDocument.linkDocDate || "",
                subRegistrar: data.linkDocument.subRegistrar || "",
                subRegistrarCode: data.linkDocument.subRegistrarCode || "",
                pattadarPassbookNo: data.linkDocument.pattadarPassbook || "",
                passbookKhataNo: data.linkDocument.passbookKhataNo || data.linkDocument.khataNo || "",
                nalaOrderNo: data.linkDocument.nalaOrderNo || "",
                houseTaxReceipt: data.linkDocument.houseTaxReceipt || ""
              }];
            }
          }
        });
      }

      // Update Property Details - Fill existing property row or create new
      if (data.property) {
        const extractedType = (data.property.propertyType as any) || propertyType || "";
        setPropertiesList(prev => {
          if (prev.length === 0) {
            return [{
              id: `property-${Date.now()}`,
              propertyType: extractedType || "Open plot",
              plotNo: data.property.plotNo || "",
              surveyNo: data.property.surveyNo || "",
              extentSqYards: data.property.extentSqYards || "",
               extentSqMeters: data.property.extentSqMeters || squareYardsToSquareMetres(data.property.extentSqYards || ""),
              nearHNo: data.property.nearHNo || "",
              locality: data.property.locality || "",
               pincode: data.property.pincode || data.jurisdiction?.pincode || "",
               vltPtiNo: data.property.vltPtiNo || data.property.ptiNo || "",
               bltNo: "",
               ptiNo: data.property.ptiNo || data.property.vltPtiNo || "",
               marketValueTotal: formatIndianCurrency(data.property.marketValueTotal || ""),
              marketValuePerSqYard: formatIndianCurrency(data.property.marketValuePerSqYard || ""),
              houseBearingHNo: data.property.nearHNo || data.property.house?.bearingHNo || "",
              houseNature: data.property.house?.nature || "",
              houseFloors: data.property.house?.floors || "",
              housePlinthArea: data.property.house?.plinthArea || "",
              houseAge: data.property.house?.age || "",
              houseTapConnection: data.property.house?.tapConnection || "",
              houseMetersNo: data.property.house?.metersNo || "",
              houseTaxes: data.property.house?.taxes || "",
              houseRentalValue: data.property.house?.rentalValue || "",
              flatNo: data.property.flat?.flatNo || "",
              flatUndividedSqYards: data.property.flat?.undividedSqYards || "",
              flatBearingHNo: data.property.flat?.bearingHNo || "",
              flatBuildingName: data.property.flat?.buildingName || "",
              flatFloorS: data.property.flat?.floorS || "",
              adjacentHNo: "",
              demoBearingHNo: data.property.nearHNo || "", demoLocality: data.property.locality || "",
              demoTapConnection: data.property.house?.tapConnection || "", demoMetersNo: data.property.house?.metersNo || "",
              partBearingHNo: data.property.nearHNo || "", partLocality: data.property.locality || "",
              flatUndividedSqMeters: "", flatNature: "", flatLocality: data.property.locality || "", flatValuePerSqFeet: "",
               flatMarketValueTotal: formatIndianCurrency(data.property.marketValueTotal || ""), flatAge: data.property.house?.age || "",
              flatTapConnection: data.property.house?.tapConnection || "", flatMetersNo: data.property.house?.metersNo || "",
              flatTaxes: "", flatRentalValue: "", flatNearHNo: data.property.nearHNo || "", flatPlinthArea: data.property.house?.plinthArea || "", flatTotalLand: ""
            }];
          } else {
            const updated = [...prev];
            const target = { ...updated[0] };
            if (!target.propertyType && extractedType) {
              target.propertyType = extractedType;
            }
            if (data.property.plotNo) target.plotNo = data.property.plotNo;
            if (data.property.surveyNo) target.surveyNo = data.property.surveyNo;
            if (data.property.extentSqYards) {
              target.extentSqYards = data.property.extentSqYards;
              if (!data.property.extentSqMeters && !target.extentSqMeters) {
                target.extentSqMeters = squareYardsToSquareMetres(data.property.extentSqYards);
              }
            }
            if (data.property.extentSqMeters) target.extentSqMeters = data.property.extentSqMeters;
            if (data.property.nearHNo) {
              target.nearHNo = data.property.nearHNo;
              target.houseBearingHNo = target.houseBearingHNo || data.property.nearHNo;
              target.demoBearingHNo = target.demoBearingHNo || data.property.nearHNo;
              target.partBearingHNo = target.partBearingHNo || data.property.nearHNo;
              target.flatBearingHNo = target.flatBearingHNo || data.property.nearHNo;
            }
            if (data.property.locality) {
              target.locality = data.property.locality;
              target.demoLocality = target.demoLocality || data.property.locality;
              target.partLocality = target.partLocality || data.property.locality;
              target.flatLocality = target.flatLocality || data.property.locality;
            }
            if (data.property.pincode || data.jurisdiction?.pincode) {
              target.pincode = data.property.pincode || data.jurisdiction?.pincode;
            }
            if (data.property.vltPtiNo || data.property.ptiNo) {
              target.vltPtiNo = data.property.vltPtiNo || data.property.ptiNo;
              target.ptiNo = data.property.ptiNo || data.property.vltPtiNo;
            }
            if (data.property.marketValueTotal) {
              target.marketValueTotal = formatIndianCurrency(data.property.marketValueTotal);
              target.flatMarketValueTotal = target.flatMarketValueTotal || formatIndianCurrency(data.property.marketValueTotal);
            }
            if (data.property.marketValuePerSqYard) target.marketValuePerSqYard = formatIndianCurrency(data.property.marketValuePerSqYard);

            if (data.property.house) {
              if (data.property.house.nature) target.houseNature = data.property.house.nature;
              if (data.property.house.floors) target.houseFloors = data.property.house.floors;
              if (data.property.house.age) target.houseAge = data.property.house.age;
              if (data.property.house.tapConnection) target.houseTapConnection = data.property.house.tapConnection;
              if (data.property.house.metersNo) target.houseMetersNo = data.property.house.metersNo;
              if (data.property.house.taxes) target.houseTaxes = data.property.house.taxes;
              if (data.property.house.rentalValue) target.houseRentalValue = data.property.house.rentalValue;
              if (data.property.house.plinthArea) target.housePlinthArea = data.property.house.plinthArea;
            }

            if (data.property.flat) {
              if (data.property.flat.flatNo) target.flatNo = data.property.flat.flatNo;
              if (data.property.flat.undividedSqYards) target.flatUndividedSqYards = data.property.flat.undividedSqYards;
              if (data.property.flat.bearingHNo) target.flatBearingHNo = data.property.flat.bearingHNo;
              if (data.property.flat.buildingName) target.flatBuildingName = data.property.flat.buildingName;
              if (data.property.flat.floorS) target.flatFloorS = data.property.flat.floorS;
            }

            updated[0] = target;
            return updated;
          }
        });

        if (!propertyType && extractedType) {
          setPropertyType(extractedType);
        }
      }

      // Update Boundaries - Fill existing row or create new
      if (data.boundaries) {
        setBoundariesList(prev => {
          if (prev.length === 0) {
            return [{
              id: `boundary-${Date.now()}`,
              east: data.boundaries.east || "",
              west: data.boundaries.west || "",
              north: data.boundaries.north || "",
              south: data.boundaries.south || ""
            }];
          } else {
            const updated = [...prev];
            updated[0] = {
              ...updated[0],
              east: data.boundaries.east || updated[0].east,
              west: data.boundaries.west || updated[0].west,
              north: data.boundaries.north || updated[0].north,
              south: data.boundaries.south || updated[0].south
            };
            return updated;
          }
        });
      }

      // Retain the raw file so the Step-5 verification can cross-check the draft against the source.
      setLinkDocuments(prev => [...prev, {
        name: file.name,
        size: `${Math.round(file.size / 1024)} KB`,
        mimeType: file.type || "application/pdf",
        base64,
        isMock: false,
      }]);

      alert("Link document details extracted and populated successfully!");

      // Reset input
      e.target.value = "";
    } catch (err) {
      // The old alert() said "check the file and try again", which sent the user
      // hunting for a bad scan when the real cause was usually server-side
      // (exhausted credits). The banner now names the actual cause.
      reportFailure(err, "Link document extraction");
    } finally {
      setUploadingLinkDocument(false);
    }
  };

  // NEW: Add empty executant row
  const addEmptyExecutant = () => {
    const newExecutant: ExecutantRow = {
      id: `exec-${Date.now()}`,
      name: "",
      relation: "",
      occupation: "",
      cellNo: "",
      aadhaarNo: "",
      age: "",
      dob: "",
      address: "",
      district: "",
      state: "",
      pincode: ""
    };
    setExecutantsList(prev => [...prev, newExecutant]);
  };

  // NEW: Add empty claimant row
  const addEmptyClaimant = () => {
    const newClaimant: ClaimantRow = {
      id: `claim-${Date.now()}`,
      name: "",
      relation: "",
      occupation: "",
      cellNo: "",
      aadhaarNo: "",
      age: "",
      dob: "",
      address: "",
      district: "",
      state: "",
      pincode: ""
    };
    setClaimantsList(prev => [...prev, newClaimant]);
  };

  // NEW: Delete executant row
  //
  // Row 0 is mirrored into the legacy singular state (executantName, executantAadhaar,
  // executantAddress, etc. — see handleAadhaarUploadExecutant and the table's row-0
  // onChange handlers) so downstream code that still reads those single fields sees
  // the same data. buildConsolidatedDetails() falls back to that legacy state ONLY
  // when executantsList is empty. Previously the table's trash button deleted rows
  // via a raw filter that never touched the legacy state and had no "keep at least
  // one" guard — so removing the only executant left executantsList empty while
  // executantName/executantAadhaar/etc. still held the just-removed party's data,
  // which buildConsolidatedDetails() then silently resurrected into the generated
  // document ("removed Aadhaar details reappear after Document Generation"). Keeping
  // the guard makes the empty-list fallback unreachable once any row has existed, and
  // re-syncing the legacy state to whatever is now row 0 (or blanking it when the
  // list is left empty) means there is never a stale value left behind to resurrect.
  const deleteExecutant = (id: string) => {
    if (executantsList.length === 1) {
      alert("At least one executant is required!");
      return;
    }
    setExecutantsList(prev => {
      const idx = prev.findIndex(exec => exec.id === id);
      const next = prev.filter(exec => exec.id !== id);
      if (idx === 0) {
        const r = next[0];
        setExecutantName(r?.name || "");
        setExecutantRelation(r?.relation || "");
        setExecutantAge(Number(r?.age) || 0);
        setExecutantAadhaar(r?.aadhaarNo || "");
        setExecutantDOB(r?.dob || "");
        setExecutantAddress(r?.address || "");
      }
      return next;
    });
  };

  // NEW: Delete claimant row (see deleteExecutant above for why the guard and the
  // legacy-state re-sync both matter — same bug, same fix, for claimants).
  const deleteClaimant = (id: string) => {
    if (claimantsList.length === 1) {
      alert("At least one claimant is required!");
      return;
    }
    setClaimantsList(prev => {
      const idx = prev.findIndex(claim => claim.id === id);
      const next = prev.filter(claim => claim.id !== id);
      if (idx === 0) {
        const r = next[0];
        setClaimantName(r?.name || "");
        setClaimantRelation(r?.relation || "");
        setClaimantAge(Number(r?.age) || 0);
        setClaimantAadhaar(r?.aadhaarNo || "");
        setClaimantDOB(r?.dob || "");
        setClaimantAddress(r?.address || "");
      }
      return next;
    });
  };

  // NEW: Update executant field
  const updateExecutant = (id: string, field: keyof ExecutantRow, value: string) => {
    setExecutantsList(prev => prev.map(exec =>
      exec.id === id ? { ...exec, [field]: value } : exec
    ));
  };

  // NEW: Update claimant field
  const updateClaimant = (id: string, field: keyof ClaimantRow, value: string) => {
    setClaimantsList(prev => prev.map(claim =>
      claim.id === id ? { ...claim, [field]: value } : claim
    ));
  };

  // NEW: Add empty link document row
  const addEmptyLinkDocument = () => {
    const newLinkDoc: LinkDocumentRow = {
      id: `linkdoc-${Date.now()}`,
      layoutFileNo: "",
      linkDocType: "",
      linkDocNo: "",
      linkDocDate: "",
      subRegistrar: "",
      subRegistrarCode: "",
      pattadarPassbookNo: "",
      passbookKhataNo: "",
      nalaOrderNo: "",
      houseTaxReceipt: ""
    };
    setLinkDocumentsList(prev => [...prev, newLinkDoc]);
  };

  // NEW: Delete link document row
  const deleteLinkDocument = (id: string) => {
    setLinkDocumentsList(prev => prev.filter(doc => doc.id !== id));
  };

  // NEW: Update link document field
  const updateLinkDocument = (id: string, field: keyof LinkDocumentRow, value: string) => {
    setLinkDocumentsList(prev => prev.map(doc =>
      doc.id === id ? { ...doc, [field]: value } : doc
    ));
  };

  // NEW: Add empty property row
  const addEmptyProperty = () => {
    const newProperty: PropertyRow = {
      id: `prop-${Date.now()}`,
      propertyType: "",
      plotNo: "",
      extentSqYards: "",
      extentSqMeters: "",
      surveyNo: "",
      nearHNo: "",
      adjacentHNo: "",
      locality: "",
      pincode: "",
      vltPtiNo: "",
      bltNo: "",
      ptiNo: "",
      marketValuePerSqYard: "",
      marketValueTotal: "",
      houseBearingHNo: "",
      houseNature: "",
      houseFloors: "",
      housePlinthArea: "",
      houseAge: "",
      houseTapConnection: "",
      houseMetersNo: "",
      houseTaxes: "",
      houseRentalValue: "",
      demoBearingHNo: "",
      demoLocality: "",
      demoTapConnection: "",
      demoMetersNo: "",
      partBearingHNo: "",
      partLocality: "",
      flatNo: "",
      flatUndividedSqYards: "",
      flatUndividedSqMeters: "",
      flatBearingHNo: "",
      flatNature: "",
      flatLocality: "",
      flatValuePerSqFeet: "",
      flatMarketValueTotal: "",
      flatAge: "",
      flatTapConnection: "",
      flatMetersNo: "",
      flatTaxes: "",
      flatRentalValue: "",
      flatBuildingName: "",
      flatNearHNo: "",
      flatFloorS: "",
      flatPlinthArea: "",
      flatTotalLand: ""
    };
    setPropertiesList(prev => [...prev, newProperty]);
  };

  // NEW: Delete property row
  const deleteProperty = (id: string) => {
    setPropertiesList(prev => prev.filter(prop => prop.id !== id));
  };

  // NEW: Update property field
  const updateProperty = (id: string, field: keyof PropertyRow, value: string) => {
    setPropertiesList(prev => prev.map(prop =>
      prop.id === id ? { ...prop, [field]: value } : prop
    ));
  };

  // NEW: Add empty boundary row
  const addEmptyBoundary = () => {
    const newBoundary: BoundaryRow = {
      id: `boundary-${Date.now()}`,
      east: "",
      west: "",
      north: "",
      south: ""
    };
    setBoundariesList(prev => [...prev, newBoundary]);
  };

  // NEW: Delete boundary row
  const deleteBoundary = (id: string) => {
    setBoundariesList(prev => prev.filter(b => b.id !== id));
  };

  // NEW: Update boundary field
  const updateBoundary = (id: string, field: keyof BoundaryRow, value: string) => {
    setBoundariesList(prev => prev.map(b =>
      b.id === id ? { ...b, [field]: value } : b
    ));
  };

  // NEW: Add empty jurisdiction row
  const addEmptyJurisdiction = () => {
    const newJurisdiction: JurisdictionRow = {
      id: `jurisdiction-${Date.now()}`,
      districtRegistrar: "",
      subRegistrar: "",
      district: "",
      mandal: "",
      village: "",
      pincode: ""
    };
    setJurisdictionsList(prev => [...prev, newJurisdiction]);
  };

  // NEW: Delete jurisdiction row
  const deleteJurisdiction = (id: string) => {
    setJurisdictionsList(prev => prev.filter(j => j.id !== id));
  };

  // NEW: Update jurisdiction field
  const updateJurisdiction = (id: string, field: keyof JurisdictionRow, value: string) => {
    setJurisdictionsList(prev => prev.map(j =>
      j.id === id ? { ...j, [field]: value } : j
    ));
  };

  // Trigger Step 4: AI Extraction (Sellers, Buyers, Property, Link Deeds)
  const triggerAIExtraction = async () => {
    setExtracting(true);
    clearAiStatus();
    try {
      const docsToExtract = [
        ...aadhaarCards.map(c => ({ name: c.name, mimeType: c.mimeType, base64: c.base64 || "" })),
        ...linkDocuments.map(l => ({ name: l.name, mimeType: l.mimeType, base64: l.base64 || "" }))
      ];

      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: docsToExtract })
      });

      if (!response.ok) await failOn(response, "Document extraction");

      const data = await response.json();
      setExtractedDetails(data);
      
      // Update our form variables with the extracted data to make them fully editable
      const seller = data.executants?.[0];
      const buyer = data.claimants?.[0];
      const prop = data.property;

      if (seller) {
        if (seller.name) setExecutantName(seller.name);
        if (seller.relation) setExecutantRelation(seller.relation);
        if (seller.age) setExecutantAge(seller.age);
        if (seller.aadhaar) setExecutantAadhaar(seller.aadhaar);
        if (seller.pan) setExecutantPan(seller.pan);
        if (seller.dob) {
          const iso = toDateInputValue(seller.dob);
          if (iso) setExecutantDOB(iso);
        }
        if (seller.address) setExecutantAddress(seller.address);
      }

      if (buyer) {
        if (buyer.name) setClaimantName(buyer.name);
        if (buyer.relation) setClaimantRelation(buyer.relation);
        if (buyer.age) setClaimantAge(buyer.age);
        if (buyer.aadhaar) setClaimantAadhaar(buyer.aadhaar);
        if (buyer.pan) setClaimantPan(buyer.pan);
        if (buyer.dob) {
          const iso = toDateInputValue(buyer.dob);
          if (iso) setClaimantDOB(iso);
        }
        if (buyer.address) setClaimantAddress(buyer.address);
      }

      if (prop) {
        if (prop.district) setPropertyDistrict(prop.district);
        if (prop.mandal) setPropertyMandal(prop.mandal);
        if (prop.village) setPropertyVillage(prop.village);
        if (prop.surveyNo) setPropertySurvey(prop.surveyNo);
        if (prop.hNo) setPropertyHNo(prop.hNo);
        if (prop.plotNo) setPropertyPlotNo(prop.plotNo);
        if (prop.ptiNo) setPropertyPTINo(prop.ptiNo);
        if (prop.extentSqYards) setPropertyExtent(prop.extentSqYards);
        if (prop.plinthArea) setPropertyPlinth(prop.plinthArea);
        if (prop.boundaries) {
          if (prop.boundaries.east) setBoundaryEast(prop.boundaries.east);
          if (prop.boundaries.west) setBoundaryWest(prop.boundaries.west);
          if (prop.boundaries.north) setBoundaryNorth(prop.boundaries.north);
          if (prop.boundaries.south) setBoundarySouth(prop.boundaries.south);
        }
      }

      // Transition smoothly to Step 4
      setTimeout(() => {
        setCurrentStep(4);
      }, 1500);

    } catch (err: any) {
      // Do NOT advance to Step 4 and do NOT invent data. The old message claimed
      // "preset mock data" had been loaded, which was only half true: the mock
      // echoed the user's own typed fields but ALSO invented a link-deed number
      // and execution date ("1204/1998", "14th August 1998") that would flow
      // into a registrable deed. The user stays on this step, sees why, and can
      // either retry or fill the fields in by hand.
      reportFailure(err, "Document extraction", () => triggerAIExtraction());
    } finally {
      setExtracting(false);
    }
  };

  // NOTE: getMockExtractedDetails() was DELETED here (44 lines). It mostly
  // echoed the user's own typed fields, but also invented a link-deed number
  // and execution date, and was presented as though extraction had succeeded.

  // Build the single consolidated "details" object used by document generation and
  // verification. Sourced from the Step-1 list rows (source of truth), falling back to
  // single-field state so nothing is silently dropped.
  const buildConsolidatedDetails = () => {
    // Append district/state/pincode to a party's residential address ONLY when
    // that token is not already present in it. The Aadhaar extractor is asked to
    // return an address that already includes village/mandal/district/pincode, so
    // blindly appending the separate district/state/pincode fields produced a
    // duplicated tail (e.g. "…, Warangal, 506002, Warangal, Telangana, 506002").
    const composeAddress = (base: string, extras: (string | undefined)[]): string => {
      let acc = (base || "").trim().replace(/[\s,]+$/, "");
      for (const t of extras) {
        const v = (t || "").trim();
        if (v && !acc.toLowerCase().includes(v.toLowerCase())) {
          acc = acc ? `${acc}, ${v}` : v;
        }
      }
      return acc;
    };
    const sellers = (executantsList.length
      ? executantsList
      : executantName
      ? [{ name: executantName, relation: executantRelation, age: String(executantAge), aadhaarNo: executantAadhaar, pan: executantPan, dob: executantDOB, address: executantAddress, occupation: "", cellNo: "", district: "", state: "Telangana", pincode: "" }]
      : []
    ).map((e: any) => ({
      name: e.name,
      relation: e.relation || "",
      age: parseInt(e.age) || undefined,
      aadhaar: e.aadhaarNo,
      pan: e.pan || "",
      dob: e.dob,
      occupation: e.occupation || "",
      cellNo: e.cellNo || "",
      address: composeAddress(cleanAddressWithoutRelation(e.address, e.relation), [e.district, e.state, e.pincode]),
    }));

    const buyers = (claimantsList.length
      ? claimantsList
      : claimantName
      ? [{ name: claimantName, relation: claimantRelation, age: String(claimantAge), aadhaarNo: claimantAadhaar, pan: claimantPan, dob: claimantDOB, address: claimantAddress, occupation: "", cellNo: "", district: "", state: "Telangana", pincode: "" }]
      : []
    ).map((c: any) => ({
      name: c.name,
      relation: c.relation || "",
      age: parseInt(c.age) || undefined,
      aadhaar: c.aadhaarNo,
      pan: c.pan || "",
      dob: c.dob,
      occupation: c.occupation || "",
      cellNo: c.cellNo || "",
      address: composeAddress(cleanAddressWithoutRelation(c.address, c.relation), [c.district, c.state, c.pincode]),
    }));

    const firstProp = propertiesList[0] || ({} as any);
    const firstJur = jurisdictionsList[0] || ({} as any);
    const firstBound = boundariesList[0] || ({} as any);
    const firstLink = linkDocumentsList[0] || ({} as any);
    const properties = propertiesList.map(({ id, ...property }) => property);
    const jurisdictions = jurisdictionsList.map(({ id, ...jurisdiction }) => jurisdiction);
    const linkDocuments = linkDocumentsList.map(({ id, ...linkDocument }) => linkDocument);

    return {
      registrationDate,
      marketValue: marketValue || firstProp.marketValueTotal || propMarketValueTotal || "",
      stampsAmount,
      natureOfTransaction,
      propertyType: firstProp.propertyType || propertyType,
      executants: sellers,
      claimants: buyers,
      property: {
        ...firstProp,
        propertyType: firstProp.propertyType || propertyType,
        surveyNo: firstProp.surveyNo || propSurveyNo || propertySurvey || "",
        village: firstJur.village || jurVillage || propertyVillage || "",
        mandal: firstJur.mandal || jurMandal || propertyMandal || "",
        district: firstJur.district || jurDistrict || propertyDistrict || "",
        pincode: firstProp.pincode || firstJur.pincode || jurPincode || propPincode || "",
        state: "Telangana",
        hNo: firstProp.houseBearingHNo || firstProp.demoBearingHNo || firstProp.partBearingHNo || firstProp.flatBearingHNo || firstProp.nearHNo || propNearHNo || propertyHNo || "",
        plotNo: firstProp.plotNo || propPlotNo || propertyPlotNo || "",
        ptiNo: firstProp.ptiNo || firstProp.vltPtiNo || propVltPtiNo || firstLink.pattadarPassbookNo || linkPattadarPassbook || propertyPTINo || "",
        vltPtiNo: firstProp.vltPtiNo || firstProp.ptiNo || propVltPtiNo || propertyPTINo || "",
        extentSqYards: firstProp.extentSqYards || propExtentSqYards || propertyExtent || "",
        plinthArea: firstProp.housePlinthArea || firstProp.flatPlinthArea || propertyPlinth || "",
        locality: firstProp.locality || "",
        // House-specific fields for "House" property type
        houseNature: firstProp.houseNature || "",
        houseFloors: firstProp.houseFloors || "",
        houseAge: firstProp.houseAge || "",
        houseTapConnection: firstProp.houseTapConnection || "",
        houseMetersNo: firstProp.houseMetersNo || "",
        houseTaxes: firstProp.houseTaxes || "",
        houseRentalValue: firstProp.houseRentalValue || "",
        // Demolished House specific fields
        demoLocality: firstProp.demoLocality || "",
        demoTapConnection: firstProp.demoTapConnection || "",
        demoMetersNo: firstProp.demoMetersNo || "",
        // Flat/Apartment specific fields
        flatNo: firstProp.flatNo || "",
        flatBuildingName: firstProp.flatBuildingName || "",
        flatFloorS: firstProp.flatFloorS || "",
        flatLocality: firstProp.flatLocality || "",
        flatPlinthArea: firstProp.flatPlinthArea || "",
        flatUndividedSqYards: firstProp.flatUndividedSqYards || "",
        flatUndividedSqMeters: firstProp.flatUndividedSqMeters || "",
        flatTapConnection: firstProp.flatTapConnection || "",
        flatMetersNo: firstProp.flatMetersNo || "",
        flatTaxes: firstProp.flatTaxes || "",
        flatRentalValue: firstProp.flatRentalValue || "",
        flatValuePerSqFeet: firstProp.flatValuePerSqFeet || "",
        flatMarketValueTotal: firstProp.flatMarketValueTotal || "",
        flatTotalLand: firstProp.flatTotalLand || "",
        boundaries: {
          east: firstBound.east || boundaryEast || "",
          west: firstBound.west || boundaryWest || "",
          north: firstBound.north || boundaryNorth || "",
          south: firstBound.south || boundarySouth || "",
        },
      },
      linkDeed: {
        deedNumber: firstLink.linkDocNo || linkDocNo || "",
        docType: firstLink.linkDocType || "",
        type: firstLink.linkDocType || "",
        executionDate: firstLink.linkDocDate || linkDocDate || "",
        village: firstLink.subRegistrar || linkSubRegistrar || "",
        subRegistrar: firstLink.subRegistrar || linkSubRegistrar || "",
        subRegistrarCode: firstLink.subRegistrarCode || linkSubRegistrarCode || "",
        pattadarPassbookNo: firstLink.pattadarPassbookNo || linkPattadarPassbook || "",
        passbookKhataNo: firstLink.passbookKhataNo || linkPassbookKhataNo || "",
        layoutFileNo: firstLink.layoutFileNo || linkLayoutFileNo || "",
        nalaOrderNo: firstLink.nalaOrderNo || linkNalaOrderNo || "",
        houseTaxReceipt: firstLink.houseTaxReceipt || linkHouseTaxReceipt || "",
      },
      properties,
      jurisdictions,
      linkDocuments,
    };
  };

  // Sentinel id used when the user brings their own uploaded template (Step 3).
  const CUSTOM_TEMPLATE_ID = "custom-upload";

  // Display name of whichever template is currently selected (library or custom upload).
  const selectedTemplateName = () =>
    selectedTemplateId === CUSTOM_TEMPLATE_ID
      ? customTemplateName || "Custom Uploaded Template"
      : serverTemplates.find((t) => t.id === selectedTemplateId)?.name || "None";

  // Step 3: handle a user-uploaded custom deed template (.docx / .doc / .txt).
  // We extract the raw WORDING here; the extracted registration details get merged
  // into it server-side in Step 4. Selecting it sets selectedTemplateId to the sentinel.
  const handleCustomTemplateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    // Templates MUST be .docx. Only the original .docx bytes let us fill in place
    // while preserving the template's tables, centered/bold headings, fonts, page
    // size and margins (the whole point of the uploaded-template flow). .doc/.txt/
    // .pdf/images would flatten all of that, so we reject them up front with a
    // clear warning and ask the user to pick a .docx — rather than silently
    // degrading the output. Reset the input so re-picking the SAME file re-fires.
    if (!lower.endsWith(".docx")) {
      input.value = "";
      const msg =
        "Only Microsoft Word .docx templates are supported. " +
        `“${file.name}” is not a .docx file. Please save your template as .docx ` +
        "(in Word: File → Save As → Word Document *.docx) and upload it again — this " +
        "preserves your tables, headings, fonts and page layout exactly.";
      setError(msg);
      alert(msg);
      return;
    }
    setCustomTemplateLoading(true);
    setError(null);
    try {
      // Guaranteed .docx here (guarded above). Extract the raw wording for the
      // merge, and keep the ORIGINAL .docx bytes for true in-place,
      // formatting-preserving fill (tables, headings, fonts, page layout).
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = (result?.value || "").trim();
      setCustomTemplateDocxBase64(await convertFileToBase64(file));

      if (!text) {
        setError("Could not read any text from that .docx template. Please try a different .docx file.");
        return;
      }
      setCustomTemplateText(text);
      setCustomTemplateName(file.name);
      // Uploading a new custom file must invalidate any draft from a prior custom
      // template (selectedTemplateId stays "custom-upload", so the change-effect
      // won't fire — clear it here explicitly).
      setFilledDeedText("");
      setGeneratedDocxBase64("");
      setUnresolvedPlaceholders([]);
      setMergeMode("");
      setSelectedTemplateId(CUSTOM_TEMPLATE_ID); // auto-select the uploaded template
    } catch (err) {
      console.error("Custom template upload failed:", err);
      const msg = err instanceof Error && err.message ? err.message : "";
      setError(
        msg || "Failed to read the uploaded template. Please ensure it is a valid Word .docx file."
      );
    } finally {
      setCustomTemplateLoading(false);
      // Reset the input so re-uploading the same file re-triggers onChange.
      if (e.target) e.target.value = "";
    }
  };

  // Load the predefined Word (.docx) template library from the server (Step 3).
  const loadTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const res = await fetch("/api/templates");
      // res.ok was never checked: the endpoint returns `{error, templates: []}`
      // with HTTP 500 on failure, so an outage silently produced an EMPTY
      // template list and a Step-3 picker with nothing in it and no explanation.
      if (!res.ok) await failOn(res, "Loading the template library");
      const data = await res.json();
      const templates: ServerTemplate[] = data.templates || [];
      setServerTemplates(templates);
      // Auto-select the template whose registrationTypes best matches the chosen property type.
      if (!selectedTemplateId && templates.length) {
        const match = templates.find(t =>
          t.registrationTypes?.some(rt => rt.toLowerCase() === (propertyType || "").toLowerCase())
        );
        setSelectedTemplateId(match ? match.id : templates[0].id);
      }
    } catch (err) {
      reportFailure(err, "Loading the template library", () => loadTemplates());
    } finally {
      setTemplatesLoading(false);
    }
  };

  // Load templates when entering Step 3 (generate flow only — verify's Step 3 is
  // the audit and has no template picker).
  useEffect(() => {
    if (flowMode === "generate" && currentStep === 3 && serverTemplates.length === 0) {
      loadTemplates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, flowMode]);

  // If the chosen template changes, discard any previously generated draft so
  // Step 4 never shows a document built from a different template.
  useEffect(() => {
    setFilledDeedText("");
    setGeneratedDocxBase64("");
    setUnresolvedPlaceholders([]);
    setMergeMode("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  // Step 7: recompute the A4 page split whenever the deed text changes or we land
  // on Step 7. Measured against a hidden node sized to the exact printable width so
  // on-screen line wrapping matches the .docx. Deferred to rAF so the measurer has
  // laid out. When NOT actively editing, we re-flow; while editing we leave the
  // page list alone so the caret doesn't jump.
  useEffect(() => {
    if (currentStep !== 7) return;
    if (previewEditing) return;
    let raf = 0;
    const run = () => {
      const m = deedMeasureRef.current;
      if (!m) { raf = requestAnimationFrame(run); return; }
      const pages = paginateDeedText(filledDeedText, m);
      setDeedPages(pages);
      setCurrentPageIdx((idx) => Math.min(idx, pages.length - 1));
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filledDeedText, currentStep, previewEditing]);

  // Step 7: scale the full-size A4 sheet down to fit the panel width (never up past
  // 1:1), so the page is fully visible without a horizontal scrollbar on any screen.
  useEffect(() => {
    if (currentStep !== 7) return;
    const fit = () => {
      const wrap = previewWrapRef.current;
      if (!wrap) return;
      // clientWidth includes the wrapper's p-5 padding (20px each side); subtract it
      // so the scaled sheet fits inside the padded area rather than being clipped.
      const cs = window.getComputedStyle(wrap);
      const padX = parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
      const avail = Math.max(0, wrap.clientWidth - padX);
      setPreviewScale(avail > 0 ? Math.min(1, avail / A4_WIDTH_PX) : 1);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, deedPages.length]);

  // Whenever a fresh filled .docx arrives from the server, clear any prior
  // render error so the live preview is attempted again (both Step 4 and Step 7).
  useEffect(() => {
    if (generatedDocxBase64) setDocxPreviewError(false);
  }, [generatedDocxBase64]);

  // Step 4: generate the merged, formatted Word document server-side.
  // Uses the selected .docx template + consolidated details.
  //   advanceAfter=false → generate and STAY on Step 4 (used by "Regenerate" so
  //     the user can re-review in place).
  //   advanceAfter=true  → generate and move on to Re-Verify (Step 5), the
  //     natural "Generate & Fill Document / Next" behavior.
  const generateDocument = async (advanceAfter: boolean = false) => {
    if (!selectedTemplateId) {
      setError("Please select a template first.");
      return;
    }
    setFilling(true);
    clearAiStatus();
    try {
      const details = buildConsolidatedDetails();
      const isCustom = selectedTemplateId === CUSTOM_TEMPLATE_ID;
      const res = await fetch("/api/generate-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isCustom
            ? { customTemplateText, customTemplateName, customTemplateDocxBase64, details }
            : { templateId: selectedTemplateId, details }
        ),
      });
      if (!res.ok) await failOn(res, "Document generation");
      const data = await res.json();
      setFilledDeedText(data.mergedText || "");
      setGeneratedDocxBase64(data.docxBase64 || "");
      setUnresolvedPlaceholders(data.unresolvedPlaceholders || []);
      setMergeMode(data.mergeMode || "");
      // A CUSTOM upload asks for an AI merge; a library template is deterministic
      // by design and the server sends no degradation flags for it. So this only
      // reports when the AI leg was genuinely wanted and unavailable.
      noteDegradation(data, "Document generation");
      // The generated document is now shown on Step 4 for review. When invoked
      // from the primary "Generate & Fill Document" action, continue straight to
      // the Re-Verify step so the button always moves the flow forward.
      if (advanceAfter) setCurrentStep(5);
    } catch (err: any) {
      reportFailure(err, "Document generation", () => generateDocument(advanceAfter));
    } finally {
      setFilling(false);
    }
  };

  // Auto-reverify EVERY placeholder — not a fixed list — the moment the user
  // leaves Step 1. Previously, unresolvedPlaceholders was a snapshot taken the
  // instant Generate/Regenerate ran; if the document had already been generated
  // with gaps (e.g. "<Executant Dob>") and the user then went back to Step 1 and
  // filled those fields, nothing re-ran the merge — the stale placeholder list
  // (and the literal <Angle Bracket> text baked into the document) just sat there
  // until a manual "Regenerate" click. Since generateDocument() always rebuilds
  // from buildConsolidatedDetails() + the template, silently re-running it here
  // re-checks the WHOLE placeholder set, whatever it is, not any specific field.
  const prevStepRef = useRef(currentStep);
  useEffect(() => {
    const prevStep = prevStepRef.current;
    prevStepRef.current = currentStep;
    if (
      flowMode === "generate" &&
      prevStep === 1 &&
      currentStep !== 1 &&
      filledDeedText.trim() &&
      unresolvedPlaceholders.length > 0 &&
      !previewEditing &&
      !filling
    ) {
      generateDocument(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  // Convert a base64 payload to a Blob and trigger a browser download.
  const downloadBase64 = (base64: string, mimeType: string, filename: string) => {
    const byteChars = atob(base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Rasterise the registration-plan SVG (a data:image/svg+xml URL) into a RASTER
  // image in the browser so the server can embed it in the Word/PDF and the user
  // can download a real image. Word/LibreOffice cannot embed a raw SVG reliably,
  // and there is no server-side rasteriser, so we render it here (the browser
  // already draws this exact SVG) on a canvas at `scale`x for print crispness.
  //
  // Returns the FULL data URL, the raw base64 (no prefix) and pixel dimensions.
  // `mime` selects the output format — "image/jpeg" for a universally-openable
  // download and a smaller Word payload; JPEG needs an opaque background, which we
  // paint white first (the SVG's own bg is white anyway).
  const rasterizePlan = (
    svgDataUrl: string,
    scale = 2,
    mime: "image/jpeg" | "image/png" = "image/jpeg",
    quality = 0.92
  ): Promise<{ dataUrl: string; base64: string; width: number; height: number }> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 800;
        const h = img.naturalHeight || 1131;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas 2D context unavailable"));
          return;
        }
        // Flatten onto white — essential for JPEG (no alpha) and explicit for PNG
        // so transparency never bleeds through in the .docx.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          const dataUrl = canvas.toDataURL(mime, quality);
          resolve({
            dataUrl,
            base64: dataUrl.replace(/^data:[^,]+,/, ""),
            width: canvas.width,
            height: canvas.height,
          });
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error("Failed to load plan SVG for rasterisation"));
      img.src = svgDataUrl;
    });

  // Download the generated plan as a real JPG. The plan is held as an SVG data URL,
  // so we rasterise it to JPEG first — previously the button just renamed the SVG
  // bytes to ".png", producing a file image viewers could not open.
  const downloadPlanImage = async () => {
    if (!generatedPlanImage) return;
    try {
      const { base64 } = await rasterizePlan(generatedPlanImage, 2, "image/jpeg");
      const nameForFile = (executantsList[0]?.name || executantName || "plot").replace(/\s+/g, "_");
      downloadBase64(base64, "image/jpeg", `registration-plan-${nameForFile}.jpg`);
    } catch (e) {
      console.error("Plan download failed:", e);
      setError("Could not prepare the plan image for download. Please re-generate the plan and try again.");
    }
  };

  // Step 8: export the final deed as .docx (mandatory) or .pdf (best-effort).
  // Manual text edits diverge from the server-filled .docx, so we drop those bytes:
  // the preview then re-renders from the edited text and the download rebuilds from
  // it too — keeping preview === download and honoring every edit. (When the user
  // never edits, the pristine filled .docx with tables/formatting is used as-is.)
  const handleDeedTextEdit = (value: string) => {
    setFilledDeedText(value);
    if (generatedDocxBase64) setGeneratedDocxBase64("");
  };

  // Rebuild a FORMATTED .docx from the (edited) deed text so the preview shows the
  // same formatting that downloads — bold/centered headings, justified paragraphs,
  // A4/Times layout — instead of falling back to a flat plain-text page. Called
  // when the user leaves Edit mode after changing the text (which drops the
  // original filled-.docx bytes, since edited text can no longer be spliced back
  // into that document). Best-effort: on failure the text view remains.
  const rebuildDocxFromEditedText = async () => {
    if (!filledDeedText.trim()) return;
    try {
      const res = await fetch("/api/export-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "docx", finalText: filledDeedText }),
      });
      if (!res.ok) return; // keep the editable text view if the rebuild fails
      const data = await res.json();
      const b64 = data?.fileBase64 || data?.docxBase64;
      if (b64) {
        setDocxPreviewError(false);
        setGeneratedDocxBase64(b64);
      }
    } catch {
      /* keep the text fallback */
    }
  };

  // Toggle the Step-4/Step-6 preview editor. When LEAVING edit mode after an edit
  // (the formatted bytes were dropped), rebuild a formatted .docx so the preview
  // regains its formatting. When no edit happened, the original formatted .docx
  // (with any template tables) is left intact — no needless rebuild.
  const togglePreviewEditing = () => {
    setPreviewEditing((v) => {
      const leaving = v; // was editing, now turning off
      if (leaving && !generatedDocxBase64 && filledDeedText.trim()) {
        void rebuildDocxFromEditedText();
      }
      return !v;
    });
  };

  // Build the download file name as: "<Deed Type> - <Claimant> - DDMMYYYY - Vn".
  //  • Deed type comes from the nature of transaction (e.g. "Sale Deed", "Gift
  //    Settlement Deed"); when nothing is specified it falls back to "Deed".
  //  • Claimant is the first claimant/buyer name.
  //  • Date is the registration date as DDMMYYYY.
  //  • Version auto-increments per unique "<type> - <claimant> - <date>" base:
  //    the browser saves duplicate downloads as "name (1).docx" rather than "V2",
  //    so we track the count in localStorage to produce a real V1 → V2 → V3 …
  const buildDeedFileName = (ext: "docx" | "pdf"): string => {
    const rawNature = (natureOfTransaction || "").trim();
    let deedType = rawNature
      ? /deed/i.test(rawNature)
        ? rawNature
        : `${rawNature} Deed`
      : "Deed";
    const claimant = (claimantsList[0]?.name || claimantName || "Claimant").trim();
    // registrationDate is an ISO date input value (YYYY-MM-DD). Format DDMMYYYY.
    let dmy = "";
    const iso = (registrationDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) dmy = `${iso[3]}${iso[2]}${iso[1]}`;
    else {
      const t = new Date();
      dmy = `${String(t.getDate()).padStart(2, "0")}${String(t.getMonth() + 1).padStart(2, "0")}${t.getFullYear()}`;
    }
    const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
    const base = `${clean(deedType)} - ${clean(claimant)} - ${dmy}`;
    // Version counter (per base, this browser). Bump on each export.
    let version = 1;
    try {
      const key = `deed_export_versions`;
      const store = JSON.parse(localStorage.getItem(key) || "{}");
      version = (Number(store[base]) || 0) + 1;
      store[base] = version;
      localStorage.setItem(key, JSON.stringify(store));
    } catch { /* localStorage unavailable — keep V1 */ }
    return `${base} - V${version}.${ext}`;
  };
  const exportDocument = async (format: "docx" | "pdf") => {
    setExporting(format);
    clearAiStatus();
    try {
      // If a registration plan was generated, rasterise it so the server appends it
      // as the LAST page of the exported document. Best-effort: on any failure we
      // still export the deed itself.
      let planFields: Record<string, unknown> = {};
      if (generatedPlanImage) {
        try {
          const jpg = await rasterizePlan(generatedPlanImage, 2, "image/jpeg");
          planFields = {
            planImagePngBase64: jpg.base64, // JPEG bytes; server embeds as-is
            planImageWidthPx: jpg.width,
            planImageHeightPx: jpg.height,
          };
        } catch (e) {
          console.warn("Could not rasterise plan for document append; exporting without it:", e);
        }
      }

      // Download EXACTLY what the Stamp Preview showed. /api/generate-document
      // already produced the in-place filled .docx (tables, centered/bold titles,
      // fonts, page breaks intact) and the preview rendered THOSE bytes — so we ship
      // them back as `filledDocxBase64` and the server merely appends the plan page.
      // This makes download === preview and can never silently lose the tables.
      //   • templateDocxBase64 → server can re-fill in place if the pre-filled bytes
      //     are somehow absent (e.g. the user hand-edited the text).
      //   • finalText → last-resort text rebuild for library templates.
      const details = buildConsolidatedDetails();
      // Uploaded Aadhaar/PAN card images, appended by the server as a single page
      // AFTER the plan page. Only real uploads are sent (mock preset files and any
      // without base64 are skipped).
      const aadhaarImages = aadhaarCards
        .filter((c) => c.base64 && !c.isMock)
        .map((c) => ({ base64: c.base64 as string, mimeType: c.mimeType || "image/jpeg", name: c.name || "aadhaar" }));
      const res = await fetch("/api/export-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          filledDocxBase64: (!previewEditing && generatedDocxBase64) || undefined,
          finalText: filledDeedText,
          templateDocxBase64: customTemplateDocxBase64 || undefined,
          details,
          ...planFields,
          aadhaarImages,
        }),
      });
      if (!res.ok) await failOn(res, `${format.toUpperCase()} export`);
      const data = await res.json();

      if (format === "pdf" && data.pdfUnavailable) {
        // LibreOffice not present: hand back the .docx and tell the user to use Print → Save as PDF.
        downloadBase64(data.fileBase64, data.mimeType, buildDeedFileName("docx"));
        alert(data.message || "PDF engine unavailable. Downloaded Word (.docx); use the Print button to save as PDF.");
      } else if (data.format === "pdf") {
        downloadBase64(data.fileBase64, data.mimeType, buildDeedFileName("pdf"));
      } else {
        downloadBase64(data.fileBase64, data.mimeType, buildDeedFileName("docx"));
      }

      // Make the appended extras VISIBLE so it's never a mystery whether the plan
      // and Aadhaar pages went in. They are added as the LAST pages of the file.
      const appended: string[] = [];
      if ((planFields as any).planImagePngBase64) appended.push("registration plan page");
      if (aadhaarImages.length) appended.push(`${aadhaarImages.length} Aadhaar/PAN image page`);
      if (appended.length) {
        console.info("[export] appended to end of document:", appended.join(" + "));
      }
      // A plan was generated but could not be rasterised → it silently would not
      // append. Tell the user instead of leaving them to wonder.
      if (generatedPlanImage && !(planFields as any).planImagePngBase64) {
        setDegraded({
          code: "UNKNOWN",
          message:
            "The document downloaded, but the registration plan could not be added as a page. Please re-open Step 6, regenerate the plan, then export again.",
          retryable: true,
          status: 200,
        });
      }
    } catch (err: any) {
      reportFailure(err, `${format.toUpperCase()} export`, () => exportDocument(format));
    } finally {
      setExporting("");
    }
  };

  // ADDITIONAL export option: appends the registration plan as native, editable
  // Word shapes (text boxes for every label/dimension/party paragraph, a
  // freeform plot outline, road-band rectangles, north-arrow primitives)
  // instead of one flat picture — so in Word the user can click and retype a
  // dimension, drag a boundary vertex, or delete/redraw a line. This does NOT
  // replace the existing image-based plan page; it downloads a SEPARATE .docx
  // so the always-reliable image export stays available regardless of how this
  // new native-shapes rendering looks once actually opened in Word/LibreOffice
  // (not visually verified in the dev environment — please check the result
  // opens correctly on your own machine before relying on it).
  const exportEditablePlanDocument = async () => {
    if (!generatedPlanImage) {
      setError("Generate the plan first (Step 6) before exporting an editable version.");
      return;
    }
    setExportingEditablePlan(true);
    clearAiStatus();
    try {
      const consolidated = buildConsolidatedDetails();
      const aadhaarImages = aadhaarCards
        .filter((c) => c.base64 && !c.isMock)
        .map((c) => ({ base64: c.base64 as string, mimeType: c.mimeType || "image/jpeg", name: c.name || "aadhaar" }));
      const res = await fetch("/api/export-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "docx",
          filledDocxBase64: (!previewEditing && generatedDocxBase64) || undefined,
          finalText: filledDeedText,
          templateDocxBase64: customTemplateDocxBase64 || undefined,
          details: consolidated,
          aadhaarImages,
          // Editable plan page only — the flat-image plan page is a separate,
          // already-available export (the plain "Download Word" button).
          editablePlanOnly: true,
          editablePlan: {
            plan: extractedPlan,
            details: consolidated,
            customPrompt: planCustomPrompt,
          },
        }),
      });
      if (!res.ok) await failOn(res, "Editable plan export");
      const data = await res.json();
      downloadBase64(data.fileBase64, data.mimeType, buildDeedFileName("docx").replace(/\.docx$/i, " - Editable Plan.docx"));
    } catch (err: any) {
      reportFailure(err, "Editable plan export", exportEditablePlanDocument);
    } finally {
      setExportingEditablePlan(false);
    }
  };

  // Print the deed using an A4-formatted print window that mirrors the stamp-paper spec.
  const printDeed = () => {
    const w = window.open("", "_blank", "width=850,height=1100");
    if (!w) {
      alert("Please allow pop-ups to print the deed.");
      return;
    }
    const safe = (filledDeedText || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    w.document.write(`<!DOCTYPE html><html><head><title>Sale Deed</title>
      <style>
        @page { size: A4; margin: 1in 0.75in 1in 0.75in; }
        @page :first { margin-top: 5.8in; }
        body { font-family: 'Times New Roman', Times, serif; font-size: 14pt; line-height: 1.5; color: #000; white-space: pre-wrap; }
      </style></head><body>${safe}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); }, 400);
  };

  // Trigger Step 7: Fill Extracted facts into Model Template Draft
  const autoFillTemplate = async () => {
    setFilling(true);
    clearAiStatus();
    try {
      const template = MODEL_TEMPLATES.find(t => t.id === selectedModelId);
      const templateText = template ? template.templateText : customModelText;
      
      // Build high-fidelity facts list consolidated from the user's Step 3 Registration Form state
      const details = buildConsolidatedDetails();

      const response = await fetch("/api/fill-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateText, extractedDetails: details })
      });

      if (!response.ok) await failOn(response, "Template auto-fill");

      const data = await response.json();
      setFilledDeedText(data.filledText);
      // The server may have filled this with its own local substitution engine
      // rather than AI. The text is real either way (it is the user's template
      // merged with the user's data), but the user must know AI phrasing/cleanup
      // did not run so they review the wording before registering.
      noteDegradation(data, "Template auto-fill");

      // Move to Step 6 (Re-Verify Deed)
      setCurrentStep(6);
    } catch (err: any) {
      // Unlike extraction, this fallback INVENTS NOTHING — it merges the user's
      // own details into the user's own selected template with local
      // substitution. So we still proceed, but the banner says AI did not run.
      const f = reportFailure(err, "Template auto-fill", () => autoFillTemplate());
      setFailure(null);            // not blocking: a usable draft was produced
      setDegraded(f);
      setFilledDeedText(localFillDeedHeuristics());
      setCurrentStep(6);
    } finally {
      setFilling(false);
    }
  };

  const localFillDeedHeuristics = (): string => {
    const template = MODEL_TEMPLATES.find(t => t.id === selectedModelId);
    let text = template ? template.templateText : (customModelText || `SALE DEED
    
This Deed of Sale is executed on {{REGISTRATION_DATE}} at {{PROPERTY_VILLAGE}}, by:
SELLER: Sri {{SELLER_NAME}}, {{SELLER_RELATION}}, age {{SELLER_AGE}}, Aadhaar {{SELLER_AADHAAR}}.
BUYER: Sri {{BUYER_NAME}}, {{BUYER_RELATION}}, age {{BUYER_AGE}}, Aadhaar {{BUYER_AADHAAR}}.
PROPERTY: Plot {{PROPERTY_PLOT}}, H.No {{PROPERTY_HNO}}, Survey {{PROPERTY_SURVEY}}, Extent {{PROPERTY_EXTENT}}.
Boundaries: East: {{BOUNDARY_EAST}}, West: {{BOUNDARY_WEST}}, North: {{BOUNDARY_NORTH}}, South: {{BOUNDARY_SOUTH}}.`);
    
    // Construct dynamic multi-seller format
    const sellerNamesText = executantsList.map(e => e.name).join(", ");
    const sellerAadhaarsText = executantsList.map(e => e.aadhaarNo).join(", ");
    const sellerAgesText = executantsList.map(e => `${e.age} Years`).join(", ");
    const sellerAddressText = executantsList.map(e => `${e.address}, ${e.district}`).join("; ");

    // Construct dynamic multi-buyer format
    const buyerNamesText = claimantsList.map(c => c.name).join(", ");
    const buyerAadhaarsText = claimantsList.map(c => c.aadhaarNo).join(", ");
    const buyerAgesText = claimantsList.map(c => `${c.age} Years`).join(", ");
    const buyerAddressText = claimantsList.map(c => `${c.address}, ${c.district}`).join("; ");

    const replacements: Record<string, string> = {
      "{{REGISTRATION_DATE}}": registrationDate,
      "{{SELLER_NAME}}": sellerNamesText || executantName,
      "{{SELLER_RELATION}}": executantRelation,
      "{{SELLER_AGE}}": sellerAgesText || `${executantAge} Years`,
      "{{SELLER_AADHAAR}}": sellerAadhaarsText || executantAadhaar,
      "{{SELLER_PAN}}": executantPan,
      "{{SELLER_ADDRESS}}": sellerAddressText || executantAddress,
      "{{BUYER_NAME}}": buyerNamesText || claimantName,
      "{{BUYER_RELATION}}": claimantRelation,
      "{{BUYER_AGE}}": buyerAgesText || `${claimantAge} Years`,
      "{{BUYER_AADHAAR}}": buyerAadhaarsText || claimantAadhaar,
      "{{BUYER_PAN}}": claimantPan,
      "{{BUYER_ADDRESS}}": buyerAddressText || claimantAddress,
      "{{PROPERTY_SURVEY}}": propSurveyNo,
      "{{PROPERTY_VILLAGE}}": jurVillage,
      "{{PROPERTY_MANDAL}}": jurMandal,
      "{{PROPERTY_DISTRICT}}": jurDistrict,
      "{{PROPERTY_HNO}}": propNearHNo,
      "{{PROPERTY_PLOT}}": propPlotNo,
      "{{PROPERTY_PTI}}": linkPattadarPassbook,
      "{{PROPERTY_EXTENT}}": propExtentSqYards,
      "{{PROPERTY_PLINTH}}": propertyPlinth,
      "{{BOUNDARY_EAST}}": boundaryEast,
      "{{BOUNDARY_WEST}}": boundaryWest,
      "{{BOUNDARY_NORTH}}": boundaryNorth,
      "{{BOUNDARY_SOUTH}}": boundarySouth,
      "{{LINK_DEED_NO}}": linkDocNo,
      "{{LINK_DEED_DATE}}": "14th August 1998"
    };

    Object.entries(replacements).forEach(([placeholder, value]) => {
      text = text.replaceAll(placeholder, value);
    });

    return text;
  };

  // Downscale a possibly-huge phone photo of a hand-drawn sketch to a sane size
  // BEFORE sending it to the server for vision analysis. A raw 12MP JPEG can be
  // 5-10MB of base64 and makes the Gemini vision call slow enough to stall; a
  // ~1600px longest-edge JPEG keeps all the legible detail at a fraction of the
  // bytes. Returns the original string unchanged if anything goes wrong.
  const downscaleSketch = (dataUrl: string, maxEdge = 1600, quality = 0.82): Promise<string> =>
    new Promise((resolve) => {
      try {
        if (!dataUrl.startsWith("data:image/")) return resolve(dataUrl);
        const img = new Image();
        img.onload = () => {
          const { width, height } = img;
          const longest = Math.max(width, height);
          if (!longest || longest <= maxEdge) return resolve(dataUrl); // already small
          const scale = maxEdge / longest;
          const w = Math.round(width * scale);
          const h = Math.round(height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(dataUrl);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      } catch {
        resolve(dataUrl);
      }
    });

  // Function to call /api/generate-plan with the sketch base64 image and property details
  const handleGeneratePlan = async (overridePrompt?: string, overrideImage?: string) => {
    const base64Raw = overrideImage || sketchImage;
    if (!base64Raw) {
      setError("Please upload a hand-drawn sketch image first.");
      return;
    }

    // Guards against a stale response overwriting a newer one. If the user
    // fires "Apply Prompt", then edits/clears the prompt box and clicks
    // "Apply & Re-generate" again before the FIRST request has returned, the
    // two requests race — and without this guard, whichever HTTP response
    // happens to land last wins, even if it was the one sent first. That is
    // exactly what made "clear the prompt and re-generate" appear to silently
    // revert to the earlier prompted image: the earlier (prompted) request's
    // response arrived after the later (cleared-prompt) one. Tagging each call
    // with an incrementing sequence number and only applying the result if it
    // is still the MOST RECENT call in flight fixes this regardless of timing.
    const myRequestId = ++planRequestSeqRef.current;

    setPlanGenerating(true);
    setPlanError(null);
    setDegraded(null);

    const consolidated = buildConsolidatedDetails();
    const currentProp: any = consolidated.property || {};

    // Client-side hard timeout so the spinner can NEVER hang forever, even if
    // the server/upstream stalls. Aborts the fetch and surfaces a real error.
    const controller = new AbortController();
    const CLIENT_TIMEOUT_MS = 90000;
    const timeoutId = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      // Shrink large images first (keeps the vision call fast + within limits).
      const base64ToUse = await downscaleSketch(base64Raw);

      const response = await fetch("/api/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sketchBase64: base64ToUse,
          customPrompt: overridePrompt !== undefined ? overridePrompt : planCustomPrompt,
          // Full consolidated details drive the deterministic one-pager renderer
          // (party paragraphs by transaction type, property description, area table).
          details: consolidated,
          // Flat shape retained for the boundary-verification cross-check + fallback.
          propertyDetails: {
            boundaries: currentProp.boundaries || {
              east: boundaryEast,
              west: boundaryWest,
              north: boundaryNorth,
              south: boundarySouth,
            },
            surveyNo: currentProp.surveyNo || propSurveyNo,
            plotNo: currentProp.plotNo || propPlotNo,
            extentSqYards: currentProp.extentSqYards || propExtentSqYards,
          }
        })
      });

      if (!response.ok) await failOn(response, "Plan generation");

      const data = await response.json();
      // A newer call to handleGeneratePlan started while THIS request was still
      // in flight — drop this now-stale response instead of letting it overwrite
      // the newer call's (possibly already-applied) result. See the race-guard
      // comment above where myRequestId was assigned.
      if (myRequestId !== planRequestSeqRef.current) return;
      if (data.generatedImageBase64) {
        setGeneratedPlanImage(data.generatedImageBase64);
      }
      if (data.masterPromptUsed) {
        setPlanMasterPrompt(data.masterPromptUsed);
      }
      if (data.verificationReport) {
        setPlanVerificationReport(data.verificationReport);
      }
      // May legitimately be null (no AI key / sketch read failed) — the editable
      // export still works in that case, falling back to form-boundary data only,
      // same as the image renderer does.
      setExtractedPlan(data.extractedPlan ?? null);
      // The plan image is always rendered from the user's own form data, so a
      // failed AI leg degrades rather than blocks. But it must be VISIBLE: this
      // used to go to console.warn only, so the user saw a plan with no hint
      // that the sketch was never read or the boundaries never cross-checked.
      noteDegradation(data, "Plan generation");
      if (data.imageError) {
        console.warn("Plan generation notice:", data.imageError);
      }
    } catch (err: any) {
      if (myRequestId !== planRequestSeqRef.current) return; // stale — a newer call already took over
      console.error("Error generating plan:", err);
      if (err?.name === "AbortError") {
        setPlanError(
          "Plan generation timed out. Please try again, or upload a smaller/clearer photo of the sketch."
        );
      } else {
        // Use the server's classified message rather than err.message, which for
        // a non-2xx used to be the bare string "Plan generation failed (429)".
        const f = toApiFailure(err, "Plan generation");
        setPlanError(f.hint ? `${f.message} ${f.hint}` : f.message);
      }
    } finally {
      clearTimeout(timeoutId);
      if (myRequestId === planRequestSeqRef.current) setPlanGenerating(false);
    }
  };

  // Helper to handle hand-drawn sketch file upload
  const handleSketchUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSketchFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setSketchImage(result);
      setGeneratedPlanImage(null);
      setPlanVerificationReport(null);
      setExtractedPlan(null);
      // Auto-trigger plan generation upon upload
      handleGeneratePlan(planCustomPrompt, result);
    };
    reader.readAsDataURL(file);
  };

  // Trigger Step 7: Deep Verification Audit
  const triggerDeedVerificationAudit = async () => {
    setAuditing(true);
    setReport(null);
    clearAiStatus();
    try {
      const response = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aadhaarCards,
          linkDocuments,
          draftText: filledDeedText,
          registrationDate,
          // Consolidated entered/extracted data + unresolved placeholders enable the
          // comprehensive cross-check and residual-content detection on the server.
          enteredDetails: buildConsolidatedDetails(),
          unresolvedPlaceholders,
          templateName: selectedTemplateName(),
          // VERIFY FLOW ONLY: request one row per atomic discrepancy. The generate
          // flow omits this, so its verification behaviour is unchanged.
          granularDiscrepancies: flowMode === "verify",
        })
      });

      // The server now hard-fails (429/503/504) instead of returning a verdict it
      // did not compute, so this is the ONLY path that may set a report.
      if (!response.ok) await failOn(response, "Deed verification");

      const data = await response.json();
      setReport(data);
      // Stay on Step 5 to present the verification report; the user advances to the
      // A4 preview via the "Proceed to Stamp Preview" button.
    } catch (err: any) {
      // Show NO report at all. The previous fallback rendered a fabricated audit
      // card — hardcoded names, ages and three invented "CRITICAL" discrepancies
      // pattern-matched off the draft text — which is indistinguishable from a
      // real audit on screen. On a document that gets registered, a plausible
      // fake verdict is worse than no verdict.
      setReport(null);
      reportFailure(err, "Deed verification", () => triggerDeedVerificationAudit());
    } finally {
      setAuditing(false);
    }
  };

  // VERIFY FLOW — enrich each discrepancy with its Telugu category (mirrors the
  // on-screen table) for the report/export. Shared by both downloads.
  const buildReportDiscrepancies = () =>
    (report?.allDiscrepancies || []).map((d: any) => ({
      category: d.category || "",
      categoryTe: getTeluguCategory(d.category),
      description: d.description || "",
      descriptionTe: d.descriptionTe || getTeluguDescription(d.description) || "",
      found: d.found || "",
      expected: d.expected || "",
      severity: d.severity || "",
    }));

  // VERIFY FLOW — open a clean, self-contained print window for the report. We
  // build standalone HTML instead of window.print() on the page because the
  // on-screen report lives in a CSS scale() transform inside a scroll box, which
  // browsers clip/misscale when printing directly.
  const printVerificationReport = () => {
    if (!report) return;
    const esc = (v: unknown) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const discs = buildReportDiscrepancies();
    const rows = discs.length
      ? discs
          .map((d: any) => {
            const crit = String(d.severity || "").toUpperCase() === "CRITICAL";
            const fill = crit ? "#fdecec" : "#fff6e5";
            const sevColor = crit ? "#b00020" : "#8a5a00";
            const sevTe = crit ? "తీవ్రమైనది" : "హెచ్చరిక";
            return `<tr style="background:${fill}">
              <td><strong>${esc(d.category) || "—"}</strong>${d.categoryTe ? `<div class="te">${esc(d.categoryTe)}</div>` : ""}</td>
              <td>${esc(d.description) || "—"}${d.descriptionTe ? `<div class="te">${esc(d.descriptionTe)}</div>` : ""}</td>
              <td class="found">${esc(d.found) || "—"}</td>
              <td class="expected">${esc(d.expected) || "—"}</td>
              <td class="sev" style="color:${sevColor}"><strong>${esc((d.severity || "").toUpperCase())}</strong><div class="te">${sevTe}</div></td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="5" style="background:#ecfdf3;color:#0a6b33;font-weight:600">No discrepancies detected — the document matches the entered details and uploaded documents.<div class="te">ఎటువంటి తేడాలు కనుగొనబడలేదు — పత్రం నమోదు వివరాలతో సరిపోలింది.</div></td></tr>`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Deed Verification Report</title>
      <style>
        @page { size: A4; margin: 14mm; }
        * { box-sizing: border-box; }
        body { font-family: "Nirmala UI", "Segoe UI", Arial, sans-serif; color:#1e293b; margin:0; }
        .title { text-align:center; border-bottom:2px double #94a3b8; padding-bottom:10px; margin-bottom:16px; }
        .title h1 { font-size:20px; margin:0; text-transform:uppercase; letter-spacing:.5px; }
        .title .te { font-size:14px; color:#0a4d4a; font-weight:700; margin-top:2px; }
        .meta { font-size:12px; margin-bottom:14px; }
        .meta p { margin:2px 0; }
        table { width:100%; border-collapse:collapse; font-size:11px; table-layout:fixed; }
        th, td { border:1px solid #c9d6d4; padding:6px 7px; text-align:left; vertical-align:top; word-wrap:break-word; }
        thead th { background:#0a4d4a; color:#fff; }
        thead .te { color:#bfe3df; font-size:9px; font-weight:600; }
        col.c1{width:20%} col.c2{width:30%} col.c3{width:19%} col.c4{width:19%} col.c5{width:12%}
        .te { color:#0a4d4a; font-size:10px; margin-top:2px; }
        .found { color:#b00020; font-weight:700; }
        .expected { color:#0a6b33; font-weight:700; }
        .sev { text-align:center; }
        tr, tr { page-break-inside: avoid; }
      </style></head>
      <body>
        <div class="title"><h1>Deed Verification Report</h1><div class="te">దస్తావేజు పరిశీలన నివేదిక</div></div>
        <div class="meta">
          ${verifyDocName ? `<p><strong>Document / పత్రం:</strong> ${esc(verifyDocName)}</p>` : ""}
          <p><strong>Registration Date / తేదీ:</strong> ${esc(registrationDate) || "—"}</p>
          <p><strong>Discrepancies found / గుర్తించిన తేడాలు:</strong> <span style="color:#b00020;font-weight:700">${discs.length}</span></p>
        </div>
        <table>
          <colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"></colgroup>
          <thead><tr>
            <th>Category<div class="te">వర్గం</div></th>
            <th>Issue<div class="te">సమస్య</div></th>
            <th>In Document<div class="te">పత్రంలో ఉన్నది</div></th>
            <th>Should Be<div class="te">ఉండవలసినది</div></th>
            <th>Severity<div class="te">తీవ్రత</div></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <script>window.onload=function(){window.focus();window.print();};<\/script>
      </body></html>`;

    const win = window.open("", "_blank", "width=900,height=1000");
    if (!win) {
      reportFailure(new Error("Popup blocked. Allow pop-ups to print the report."), "Print report");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  // VERIFY FLOW — download the discrepancy report as a Word .docx (5-column table).
  const downloadVerificationReport = async () => {
    if (!report) return;
    setReportDownloading("report");
    clearAiStatus();
    try {
      const res = await fetch("/api/export-verification-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discrepancies: buildReportDiscrepancies(),
          documentName: verifyDocName,
          registrationDate,
          statusMessage: report?.summary?.message || "",
        }),
      });
      if (!res.ok) await failOn(res, "Report export");
      const data = await res.json();
      const base = (verifyDocName || "deed").replace(/\.(docx?|pdf)$/i, "").replace(/\s+/g, "_");
      downloadBase64(data.fileBase64, data.mimeType, `Verification_Report_${base}.docx`);
    } catch (err: any) {
      reportFailure(err, "Report export", () => downloadVerificationReport());
    } finally {
      setReportDownloading("");
    }
  };

  // VERIFY FLOW — download the uploaded deed with a "SUGGESTED CORRECTIONS" section
  // appended at the bottom. Reuses the existing /api/export-document text path.
  const downloadCorrectedDeed = async () => {
    if (!report || !filledDeedText.trim()) return;
    setReportDownloading("corrected");
    clearAiStatus();
    try {
      const discs = report?.allDiscrepancies || [];
      let corrections = "\n\n--------------------------------------------------\n";
      corrections += "SUGGESTED CORRECTIONS / సూచించిన సవరణలు\n";
      corrections += "--------------------------------------------------\n";
      if (discs.length === 0) {
        corrections += "No discrepancies detected. / ఎటువంటి తేడాలు కనుగొనబడలేదు.\n";
      } else {
        discs.forEach((d: any, i: number) => {
          const rec = d.recommendation || `Update to: ${d.expected || ""}`;
          const recTe = d.recommendationTe || getTeluguRecommendation(d.recommendation) || "";
          corrections += `\n${i + 1}. [${(d.severity || "").toUpperCase()}] ${d.category || ""}\n`;
          corrections += `   In document / పత్రంలో: ${d.found || "—"}\n`;
          corrections += `   Should be / ఉండవలసినది: ${d.expected || "—"}\n`;
          corrections += `   Action / చర్య: ${rec}\n`;
          if (recTe) corrections += `   సూచన: ${recTe}\n`;
        });
      }
      const finalText = filledDeedText + corrections;
      const res = await fetch("/api/export-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "docx", finalText }),
      });
      if (!res.ok) await failOn(res, "Corrected deed export");
      const data = await res.json();
      const base = (verifyDocName || "deed").replace(/\.(docx?|pdf)$/i, "").replace(/\s+/g, "_");
      downloadBase64(data.fileBase64, data.mimeType, `Corrected_${base}.docx`);
    } catch (err: any) {
      reportFailure(err, "Corrected deed export", () => downloadCorrectedDeed());
    } finally {
      setReportDownloading("");
    }
  };

  // Step 3 "Re-Audit": cross-checks the entered/reviewed Step 1-2 data against
  // the uploaded Aadhaar/link documents BEFORE the template gets auto-filled in
  // Step 4 — so a name/Aadhaar/property mismatch is caught before spending an AI
  // call merging bad data into the draft.
  const triggerPreAudit = async () => {
    setPreAuditing(true);
    setPreAuditReport(null);
    clearAiStatus();
    try {
      const response = await fetch("/api/pre-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aadhaarCards,
          linkDocuments,
          enteredDetails: buildConsolidatedDetails(),
          registrationDate,
        }),
      });

      if (!response.ok) await failOn(response, "Pre-draft audit");

      const data = await response.json();
      setPreAuditReport(data);
    } catch (err: any) {
      // Same fail-closed reasoning as the post-draft audit: show NO report
      // rather than a fabricated verdict on data nobody actually checked.
      setPreAuditReport(null);
      reportFailure(err, "Pre-draft audit", () => triggerPreAudit());
    } finally {
      setPreAuditing(false);
    }
  };

  // Feature #5: translate the generated deed (filledDeedText) into Telugu via
  // Gemini and produce a SEPARATE, standalone .docx set in the Sree
  // Krushnadevaraya font — downloaded independently of the main English deed.
  const translateDeedToTelugu = async () => {
    if (!filledDeedText.trim()) return;
    setTeluguTranslating(true);
    setTeluguDocxBase64("");
    clearAiStatus();
    try {
      const response = await fetch("/api/translate-deed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deedText: filledDeedText }),
      });
      if (!response.ok) await failOn(response, "Telugu translation");
      const data = await response.json();
      setTeluguDocxBase64(data.docxBase64 || "");
      if (data.docxBase64) {
        const nameForFile = (claimantsList[0]?.name || claimantName || "deed").replace(/\s+/g, "_");
        downloadBase64(
          data.docxBase64,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          `Telugu_Translation_${nameForFile}.docx`
        );
      }
    } catch (err: any) {
      setTeluguDocxBase64("");
      reportFailure(err, "Telugu translation", () => translateDeedToTelugu());
    } finally {
      setTeluguTranslating(false);
    }
  };

const getTeluguCategory = (category: string) => {
  if (!category) return "";
  const catLower = category.toLowerCase();
  if (catLower.includes("name")) return "పేర్ల వ్యత్యాసం";
  if (catLower.includes("property")) return "ఆస్తి వివరాల వ్యత్యాసం";
  if (catLower.includes("link")) return "లింక్ దస్తావేజు వ్యత్యాసం";
  if (catLower.includes("boundary") || catLower.includes("boundaries")) return "సరిహద్దుల వ్యత్యాసం";
  if (catLower.includes("identity") || catLower.includes("aadhaar")) return "గుర్తింపు వ్యత్యాసం";
  if (catLower.includes("residual")) return "ఇతర ఆస్తి వివరాల లోపం";
  if (catLower.includes("complete")) return "అసంపూర్తి వివరాలు";
  return "వ్యత్యాసం";
};

const getTeluguDescription = (desc: string) => {
  if (!desc) return "";
  const lower = desc.toLowerCase();
  if (lower.includes("spelling variation") || (lower.includes("spelling") && lower.includes("ankem"))) {
    return "పేరు అక్షరక్రమం తేడా: డ్రాఫ్ట్‌లో 'అంకెo శ్రీనివాసరావు' అని ఉంది, కానీ ఆధార్‌లో 'అంకెo శ్రీనివాస్' అని ఉంది.";
  }
  if (lower.includes("plot number mismatch") || lower.includes("plot no 15")) {
    return "ప్లాట్ నంబర్ తేడా: డ్రాఫ్ట్‌లో ప్లాట్ నంబర్ 15 అని ఉంది, కానీ ఒరిజినల్ లింక్ దస్తావేజులో ప్లాట్ నంబర్ 12 ఉంది.";
  }
  if (lower.includes("deed reference typo") || lower.includes("2340/1998")) {
    return "లింక్ దస్తావేజు నంబర్ పొరపాటు: డ్రాఫ్ట్‌లో 2340/1998 అని ప్రస్తావించారు, కానీ ఒరిజినల్ దస్తావేజు నంబర్ 2304/1998.";
  }
  if (lower.includes("age written") || lower.includes("age mismatch")) {
    return "వయస్సు వ్యత్యాసం: ఆధార్ పుట్టిన తేదీ ఆధారంగా రాసిన వయస్సు డ్రాఫ్ట్ పత్రంతో సరిపోలలేదు.";
  }
  if (lower.includes("house number") || lower.includes("h.no")) {
    return "ఇంటి నంబర్ (H.No) వ్యత్యాసం: డ్రాఫ్ట్‌లో నమోదు చేసిన ఇంటి నంబర్ లింక్ పత్రంతో సరిపోలడం లేదు.";
  }
  if (lower.includes("pti") || lower.includes("property tax")) {
    return "ఆస్తి పన్ను గుర్తింపు నంబర్ (PTI No) వ్యత్యాసం.";
  }
  if (lower.includes("boundaries") || lower.includes("boundary")) {
    return "ఆస్తి సరిహద్దుల వ్యత్యాసం: డ్రాఫ్ట్ తూర్పు, పడమర, ఉత్తర, దక్షిణ సరిహద్దులు లింక్ పత్రంతో సరిపోలడం లేదు.";
  }
  if (lower.includes("spelling of the seller's name")) {
    return "డ్రాఫ్ట్ రిజిస్ట్రేషన్ పత్రంలో విక్రేత పేరు అక్షరక్రమం అధికారిక ఆధార్ కార్డుతో సరిపోలలేదు.";
  }
  return "";
};

const getTeluguRecommendation = (rec: string) => {
  if (!rec) return "";
  const lower = rec.toLowerCase();
  if (lower.includes("update name") || lower.includes("ankem srinivas")) {
    return "ఆధార్ కార్డు ప్రకారం డ్రాఫ్ట్‌లోని పేరును 'అంకెo శ్రీనివాస్' గా సవరించండి.";
  }
  if (lower.includes("correct plot no") || lower.includes("plot no")) {
    return "డ్రాఫ్ట్‌లో ప్లాట్ నంబర్‌ను అసలు లింక్ దస్తావేజు ప్రకారం '12' గా సవరించండి.";
  }
  if (lower.includes("correct deed citation") || lower.includes("2304/1998")) {
    return "డ్రాఫ్ట్‌లో ప్రస్తావించిన లింక్ దస్తావేజు నంబర్‌ను '2304/1998' గా సరిచేయండి.";
  }
  if (lower.includes("update the seller's age") || lower.includes("age")) {
    return "విక్రేత వయస్సును ఆధార్ జన్మతేదీ ప్రకారం సరిచేయండి.";
  }
  if (lower.includes("house number") || lower.includes("h.no")) {
    return "ఇంటి నంబర్‌ను లింక్ దస్తావేజు ప్రకారం సవరించండి.";
  }
  if (lower.includes("boundaries") || lower.includes("boundary")) {
    return "సరిహద్దుల వివరాలను లింక్ దస్తావేజులోని వివరాల ప్రకారం సరిగ్గా నమోదు చేయండి.";
  }
  return "";
};

  // NOTE: getHeuristicReportFallback() was DELETED here (81 lines).
  // It returned a hardcoded audit verdict — invented party names, ages,
  // Aadhaar numbers and three fake CRITICAL discrepancies — selected by
  // substring-matching the draft text ("srinivasa rao", "plot no 15").
  // Rendered in the report card it was indistinguishable from a real audit.
  // Verification now fails visibly instead of fabricating a verdict.

  // ---- Persistent Save / Resume (Feature #1) --------------------------------
  // Captures every FORM-DATA field needed to resume drafting and regenerate the
  // document — deliberately EXCLUDES binary blobs (uploaded Aadhaar/link images,
  // the plan sketch image, the generated plan image, and generated .docx bytes).
  // Those can be several MB each and the browser's localStorage quota is only
  // ~5-10MB total, so keeping them out means Save never risks hitting that
  // ceiling after a handful of drafts. Resuming a draft that used those uploads
  // just asks the user to re-attach that one file if they want to re-run that
  // specific AI step (Aadhaar extraction / plan sketch extraction).
  const buildDraftSnapshot = () => ({
    currentStep,
    registrationDate,
    propertyDistrict, propertyMandal, propertyVillage, propertySurvey, propertyHNo,
    propertyPlotNo, propertyPTINo, propertyExtent, propertyPlinth,
    boundaryEast, boundaryWest, boundaryNorth, boundarySouth,
    executantName, executantRelation, executantAge, executantAadhaar, executantPan, executantDOB, executantAddress,
    claimantName, claimantRelation, claimantAge, claimantAadhaar, claimantPan, claimantDOB, claimantAddress,
    marketValue, stampsAmount, natureOfTransaction, propertyType,
    executantsList, claimantsList, linkDocumentsList, propertiesList, boundariesList, jurisdictionsList,
    jurDistrictRegistrar, jurSubRegistrar, jurDistrict, jurMandal, jurVillage, jurPincode,
    linkDocNo, linkDocDate, linkSubRegistrar, linkSubRegistrarCode, linkPattadarPassbook,
    linkPassbookKhataNo, linkNalaOrderNo, linkLayoutFileNo, linkHouseTaxReceipt,
    propertyTypeFilter, propPlotNo, propExtentSqYards, propExtentSqMeters, propSurveyNo,
    propNearHNo, propAdjacentHNo, propLocality, propPincode, propVltPtiNo,
    propMarketValuePerSqYard, propMarketValueTotal, autoAdjustBlanks,
    selectedModelId, customModelText,
    selectedTemplateId, customTemplateText, customTemplateName,
    filledDeedText, mergeMode, unresolvedPlaceholders,
    report,
    planCustomPrompt, planMasterPrompt, planVerificationReport,
    extractedDetails,
  });

  // Restores every field buildDraftSnapshot() captured. Uses `?? existing` so an
  // older/partial snapshot (or a future format change) never wipes a field to
  // blank — it just leaves whatever is already on screen for anything missing.
  const restoreDraftSnapshot = (snap: any) => {
    if (!snap) return;
    setCurrentStep(snap.currentStep ?? 1);
    setRegistrationDate(snap.registrationDate ?? registrationDate);
    setPropertyDistrict(snap.propertyDistrict ?? "");
    setPropertyMandal(snap.propertyMandal ?? "");
    setPropertyVillage(snap.propertyVillage ?? "");
    setPropertySurvey(snap.propertySurvey ?? "");
    setPropertyHNo(snap.propertyHNo ?? "");
    setPropertyPlotNo(snap.propertyPlotNo ?? "");
    setPropertyPTINo(snap.propertyPTINo ?? "");
    setPropertyExtent(snap.propertyExtent ?? "");
    setPropertyPlinth(snap.propertyPlinth ?? "");
    setBoundaryEast(snap.boundaryEast ?? "");
    setBoundaryWest(snap.boundaryWest ?? "");
    setBoundaryNorth(snap.boundaryNorth ?? "");
    setBoundarySouth(snap.boundarySouth ?? "");
    setExecutantName(snap.executantName ?? "");
    setExecutantRelation(snap.executantRelation ?? "");
    setExecutantAge(snap.executantAge ?? 0);
    setExecutantAadhaar(snap.executantAadhaar ?? "");
    setExecutantPan(snap.executantPan ?? "");
    setExecutantDOB(snap.executantDOB ?? "");
    setExecutantAddress(snap.executantAddress ?? "");
    setClaimantName(snap.claimantName ?? "");
    setClaimantRelation(snap.claimantRelation ?? "");
    setClaimantAge(snap.claimantAge ?? 0);
    setClaimantAadhaar(snap.claimantAadhaar ?? "");
    setClaimantPan(snap.claimantPan ?? "");
    setClaimantDOB(snap.claimantDOB ?? "");
    setClaimantAddress(snap.claimantAddress ?? "");
    setMarketValue(snap.marketValue ?? "");
    setStampsAmount(snap.stampsAmount ?? "");
    setNatureOfTransaction(snap.natureOfTransaction ?? "");
    setPropertyType(snap.propertyType ?? "");
    setExecutantsList(snap.executantsList ?? []);
    setClaimantsList(snap.claimantsList ?? []);
    setLinkDocumentsList(snap.linkDocumentsList ?? []);
    setPropertiesList(snap.propertiesList ?? []);
    setBoundariesList(snap.boundariesList ?? []);
    setJurisdictionsList(snap.jurisdictionsList ?? []);
    setJurDistrictRegistrar(snap.jurDistrictRegistrar ?? "");
    setJurSubRegistrar(snap.jurSubRegistrar ?? "");
    setJurDistrict(snap.jurDistrict ?? "");
    setJurMandal(snap.jurMandal ?? "");
    setJurVillage(snap.jurVillage ?? "");
    setJurPincode(snap.jurPincode ?? "");
    setLinkDocNo(snap.linkDocNo ?? "");
    setLinkDocDate(snap.linkDocDate ?? "");
    setLinkSubRegistrar(snap.linkSubRegistrar ?? "");
    setLinkSubRegistrarCode(snap.linkSubRegistrarCode ?? "");
    setLinkPattadarPassbook(snap.linkPattadarPassbook ?? "");
    setLinkPassbookKhataNo(snap.linkPassbookKhataNo ?? "");
    setLinkNalaOrderNo(snap.linkNalaOrderNo ?? "");
    setLinkLayoutFileNo(snap.linkLayoutFileNo ?? "");
    setLinkHouseTaxReceipt(snap.linkHouseTaxReceipt ?? "");
    setPropertyTypeFilter(snap.propertyTypeFilter ?? "Open Plot");
    setPropPlotNo(snap.propPlotNo ?? "");
    setPropExtentSqYards(snap.propExtentSqYards ?? "");
    setPropExtentSqMeters(snap.propExtentSqMeters ?? "");
    setPropSurveyNo(snap.propSurveyNo ?? "");
    setPropNearHNo(snap.propNearHNo ?? "");
    setPropAdjacentHNo(snap.propAdjacentHNo ?? "");
    setPropLocality(snap.propLocality ?? "");
    setPropPincode(snap.propPincode ?? "");
    setPropVltPtiNo(snap.propVltPtiNo ?? "");
    setPropMarketValuePerSqYard(snap.propMarketValuePerSqYard ?? "");
    setPropMarketValueTotal(snap.propMarketValueTotal ?? "");
    setAutoAdjustBlanks(snap.autoAdjustBlanks ?? true);
    setSelectedModelId(snap.selectedModelId ?? "custom-uploaded");
    setCustomModelText(snap.customModelText ?? "");
    setSelectedTemplateId(snap.selectedTemplateId ?? "");
    setCustomTemplateText(snap.customTemplateText ?? "");
    setCustomTemplateName(snap.customTemplateName ?? "");
    setFilledDeedText(snap.filledDeedText ?? "");
    setMergeMode(snap.mergeMode ?? "");
    setUnresolvedPlaceholders(snap.unresolvedPlaceholders ?? []);
    setReport(snap.report ?? null);
    setPlanCustomPrompt(snap.planCustomPrompt ?? "");
    setPlanMasterPrompt(snap.planMasterPrompt ?? "");
    setPlanVerificationReport(snap.planVerificationReport ?? null);
    setExtractedDetails(snap.extractedDetails ?? null);
    // Binary uploads (Aadhaar/link images, sketch, generated plan/docx bytes) were
    // never saved — clear any leftovers from the CURRENT session so nothing from
    // a different draft lingers on screen after resuming this one.
    setAadhaarCards([]);
    setLinkDocuments([]);
    setCustomTemplateDocxBase64("");
    setGeneratedDocxBase64("");
    setSketchImage(null);
    setSketchFileName("");
    setGeneratedPlanImage(null);
    setActivePresetId(null);
    setError(null);
    setFailure(null);
    setDegraded(null);
  };

  // Save the current form state to the offline registry. If this session is
  // already tied to a saved record (currentDraftId — set by a previous save in
  // this session, or by resuming a saved draft), that SAME record is updated
  // in place: same id, refreshed fields/snapshot/savedAt. Only when there is no
  // such record (first save ever for this deed, or its record was deleted) is
  // a brand-new entry created. This is what stops repeated "Save Draft" clicks
  // on the same deed from piling up duplicate entries in "Saved Drafts".
  const saveDraftToRegistry = (asNew: boolean = false) => {
    const existingIdx = asNew ? -1 : savedDrafts.findIndex((r) => r.id === currentDraftId);
    const id = existingIdx >= 0 ? savedDrafts[existingIdx].id : "Deed-" + Date.now();
    const record = {
      id,
      savedAt: new Date().toLocaleString(),
      seller: executantName,
      buyer: claimantName,
      property: `${propertyVillage}, Survey: ${propertySurvey}, H.No: ${propertyHNo}`,
      date: registrationDate,
      status: report?.summary?.status || "PENDING_AUDIT",
      snapshot: buildDraftSnapshot(),
    };

    const updated =
      existingIdx >= 0
        ? savedDrafts.map((r, i) => (i === existingIdx ? record : r))
        : [record, ...savedDrafts];
    try {
      localStorage.setItem("telangana_deeds_registry", JSON.stringify(updated));
    } catch (err) {
      console.error("Failed to save draft to localStorage:", err);
      alert(
        "Could not save this draft — your browser's local storage appears to be full. " +
        "Delete an older saved draft (trash icon in \"Saved Drafts\") and try again."
      );
      return;
    }
    setSavedDrafts(updated);
    setCurrentDraftId(id);
    alert(
      existingIdx >= 0
        ? "Draft updated! Your existing saved entry now reflects the latest changes."
        : "Draft saved! Find it under \"Saved Drafts\" in the header any time — even after closing this tab — " +
          "to pick up exactly where you left off."
    );
  };

  // Resume a previously saved draft: restores every form field and jumps back to
  // the step the user was on when they saved. Older records saved before this
  // feature existed have no `snapshot` and cannot be resumed.
  const loadDraftFromRegistry = (id: string) => {
    const rec = savedDrafts.find((item) => item.id === id);
    if (!rec) return;
    if (!rec.snapshot) {
      alert("This saved entry predates the Resume feature and has no saved form data to restore.");
      return;
    }
    restoreDraftSnapshot(rec.snapshot);
    // Tie this session to the record we just resumed, so the next "Save Draft"
    // updates it in place instead of creating a sibling copy.
    setCurrentDraftId(rec.id);
    setIsDraftsExpanded(false);
    alert(
      "Draft resumed — continue right where you left off. " +
      "Re-attach any Aadhaar/link photos or the plan sketch if you want to re-run those AI steps."
    );
  };

  const deleteRegistryRecord = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = savedDrafts.filter(item => item.id !== id);
    setSavedDrafts(filtered);
    localStorage.setItem("telangana_deeds_registry", JSON.stringify(filtered));
    // If the deleted record was the one this session was tracking, the next
    // Save Draft should create a fresh entry rather than "update" a record
    // that no longer exists.
    if (id === currentDraftId) setCurrentDraftId(null);
  };

  // Trigger Native Print Dialog with styled print media
  const handlePrint = () => {
    window.print();
  };

  // Rich Text/Word doc Blob downloader
  const handleDownload = (format: "txt" | "doc") => {
    const element = document.createElement("a");
    const file = new Blob([filledDeedText], { type: "text/plain;charset=utf-8" });
    element.href = URL.createObjectURL(file);
    element.download = `Final_Sale_Deed_${executantName.replace(/\s+/g, "_")}.${format === "doc" ? "doc" : "txt"}`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleCopyText = () => {
    navigator.clipboard.writeText(filledDeedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#faf9f6] text-slate-800 font-sans selection:bg-[#0a4d4a] selection:text-white pb-16">
      {/* Official Telangana Stamp Paper Header Theme */}
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-40">
        <div className="w-full mx-auto px-4 py-3 sm:px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-[#0a4d4a] to-[#14837e] flex items-center justify-center text-white shadow-md border-2 border-white">
              <FileCheck2 className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
                  Telangana Sale Deed Wizard & Registry
                </h1>
                <span className="bg-[#eef6f5] text-[#0a4d4a] text-[10px] font-bold px-2.5 py-0.5 rounded-md border border-[#c3dedb] uppercase">
                  {flowMode === "verify" ? "Verify Deed · 3 Steps" : `${totalSteps}-Step Workflow`}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Bilingual land registration, auto-filler, and stamp-duty verification desk (Telangana Stamps Act)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200">
              <Calendar className="w-4 h-4 text-[#0a4d4a]" />
              <span className="text-xs font-semibold text-slate-500">Registration Date:</span>
              <input
                type="date"
                value={registrationDate}
                onChange={(e) => setRegistrationDate(e.target.value)}
                className="bg-transparent border-none text-xs font-bold text-slate-800 outline-none focus:ring-0 cursor-pointer p-0 w-28"
              />
            </div>
            
            <button
              onClick={() => saveDraftToRegistry()}
              title={
                currentDraftId
                  ? "Update the saved draft you're currently working on — this replaces its saved data, it does not create a duplicate."
                  : "Save your progress so far — separate from Download, this lets you close the tab and pick up later."
              }
              className="bg-white border border-[#0a4d4a] text-[#0a4d4a] hover:bg-[#eef6f5] text-xs font-bold py-2 px-3.5 rounded-lg flex items-center gap-1.5 shadow-sm transition-all"
            >
              <Save className="w-3.5 h-3.5" />
              {currentDraftId ? "Update Draft" : "Save Draft"}
            </button>

            {currentDraftId && (
              <button
                onClick={() => saveDraftToRegistry(true)}
                title="Keep the original saved draft untouched and save the current form state as a brand-new, separate entry."
                className="bg-white border border-slate-300 text-slate-600 hover:bg-slate-100 text-xs font-bold py-2 px-3.5 rounded-lg flex items-center gap-1.5 shadow-sm transition-all"
              >
                <Save className="w-3.5 h-3.5" />
                Save as New
              </button>
            )}

            <button
              onClick={() => setIsDraftsExpanded(!isDraftsExpanded)}
              className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-bold py-2 px-3.5 rounded-lg flex items-center gap-1.5 shadow-sm transition-all"
            >
              <Database className="w-3.5 h-3.5" />
              Saved Drafts{savedDrafts.length > 0 ? ` (${savedDrafts.length})` : ""}
            </button>

            <button
              onClick={() => setIsPresetsExpanded(!isPresetsExpanded)}
              className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold py-2 px-3.5 rounded-lg flex items-center gap-1.5 shadow-sm transition-all"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Choose Workflow
            </button>
          </div>
        </div>
      </header>

      {/* Preset scenarios bar */}
      <AnimatePresence>
        {isPresetsExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-[#edf6f5] border-b border-[#c3dedb]"
          >
            <div className="w-full mx-auto px-4 py-4 sm:px-6 lg:px-8">
              <h3 className="text-xs font-bold text-[#0a4d4a] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <BookOpen className="w-4 h-4" /> Choose a Workflow
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Flow 1: the full 8-step generation flow */}
                <button
                  onClick={() => switchFlowMode("generate")}
                  className={`p-4 text-left rounded-lg bg-white border text-xs transition-all flex flex-col justify-between hover:shadow-sm ${
                    flowMode === "generate"
                      ? "border-[#0a4d4a] ring-2 ring-[#0a4d4a]/20 shadow-xs"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div>
                    <p className="font-bold text-slate-900 flex items-center justify-between mb-1 gap-2">
                      <span className="flex items-center gap-1.5">
                        <FileCheck2 className="w-4 h-4 text-[#0a4d4a]" />
                        Deed Document &amp; Plan Generation
                      </span>
                      {flowMode === "generate" && (
                        <span className="text-[9px] bg-[#0a4d4a] text-white px-2 py-0.5 rounded-full font-bold shrink-0">
                          Active
                        </span>
                      )}
                    </p>
                    <p className="text-slate-500 leading-relaxed text-[11px]">
                      The full 8-step workflow: enter registration details, review, pick a template,
                      auto-fill the deed, re-verify, preview on stamp paper, generate the plan, and
                      download/print.
                    </p>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400 font-mono text-right font-medium">
                    8 Steps →
                  </div>
                </button>

                {/* Flow 2: the new 3-step verify flow */}
                <button
                  onClick={() => switchFlowMode("verify")}
                  className={`p-4 text-left rounded-lg bg-white border text-xs transition-all flex flex-col justify-between hover:shadow-sm ${
                    flowMode === "verify"
                      ? "border-[#0a4d4a] ring-2 ring-[#0a4d4a]/20 shadow-xs"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div>
                    <p className="font-bold text-slate-900 flex items-center justify-between mb-1 gap-2">
                      <span className="flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-[#0a4d4a]" />
                        Verify the Deed Document
                      </span>
                      {flowMode === "verify" && (
                        <span className="text-[9px] bg-[#0a4d4a] text-white px-2 py-0.5 rounded-full font-bold shrink-0">
                          Active
                        </span>
                      )}
                    </p>
                    <p className="text-slate-500 leading-relaxed text-[11px]">
                      A focused 3-step check for an already-generated deed: enter the registration
                      details, upload the finished document, then cross-check every detail against the
                      entered data and uploaded Aadhaar/link documents.
                    </p>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400 font-mono text-right font-medium">
                    3 Steps →
                  </div>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Saved Drafts bar — persistent Save/Resume, separate from Download */}
      <AnimatePresence>
        {isDraftsExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-[#f3f6fb] border-b border-[#d6e0f0]"
          >
            <div className="w-full mx-auto px-4 py-4 sm:px-6 lg:px-8">
              <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Database className="w-4 h-4" /> Saved Drafts (stored locally in this browser)
              </h3>
              {savedDrafts.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No drafts saved yet. Click <span className="font-bold">Save Draft</span> at any time to save your progress and
                  come back to it later — even after closing this tab.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {savedDrafts.map((rec) => (
                    <button
                      key={rec.id}
                      onClick={() => loadDraftFromRegistry(rec.id)}
                      className="p-3 text-left rounded-lg bg-white border border-slate-200 hover:border-[#0a4d4a] hover:shadow-sm text-xs transition-all flex flex-col justify-between"
                    >
                      <div>
                        <p className="font-bold text-slate-900 flex items-center justify-between gap-2 mb-1">
                          <span className="truncate">{rec.seller || "Untitled draft"} → {rec.buyer || "?"}</span>
                          <span
                            onClick={(e) => deleteRegistryRecord(rec.id, e)}
                            title="Delete this saved draft"
                            className="text-slate-300 hover:text-red-600 shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </span>
                        </p>
                        <p className="text-slate-500 leading-relaxed text-[11px] line-clamp-2">
                          {rec.property || "No property details"}
                        </p>
                        <p className="text-[10px] text-slate-400 mt-1">Saved {rec.savedAt}</p>
                      </div>
                      <div className="mt-2 text-[10px] text-[#0a4d4a] font-mono text-right font-medium">
                        {rec.snapshot ? "Resume Draft →" : "No saved data (legacy entry)"}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="w-full mx-auto px-2 py-6 sm:px-3 lg:px-4">
        
        {/* Step progress bar rail */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs mb-6 overflow-x-auto scrollbar-none flex items-center justify-between gap-2">
          {workflowSteps.map((step, idx) => {
            const isCompleted = step.number < currentStep;
            const isCurrent = step.number === currentStep;
            return (
              <React.Fragment key={step.number}>
                <button
                  onClick={() => setCurrentStep(step.number)}
                  className="flex flex-col items-center text-center min-w-[75px] group shrink-0"
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border transition-all ${
                      isCompleted
                        ? "bg-emerald-600 border-emerald-600 text-white shadow-xs"
                        : isCurrent
                        ? "bg-[#0a4d4a] border-[#0a4d4a] text-white ring-4 ring-[#0a4d4a]/10"
                        : "bg-slate-50 border-slate-200 text-slate-400 group-hover:border-slate-300"
                    }`}
                  >
                    {isCompleted ? "✓" : step.number}
                  </div>
                  <span
                    className={`text-[10px] font-bold mt-1.5 leading-tight ${
                      isCurrent ? "text-[#0a4d4a] font-extrabold" : "text-slate-500"
                    }`}
                  >
                    {step.title}
                  </span>
                  <span className="text-[8px] text-slate-400 font-medium font-sans">
                    {step.telugu}
                  </span>
                </button>
                {idx < workflowSteps.length - 1 && (
                  <div
                    className={`h-0.5 w-6 shrink-0 transition-all ${
                      isCompleted ? "bg-emerald-500" : "bg-slate-200"
                    }`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* WORKSPACE AREA */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          
          {/* LEFT WIZARD CONTROLS / STEP DISPLAYS - full width unless the audit sidebar has content */}
          <div className={`${report ? "lg:col-span-8" : "lg:col-span-12"} bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden min-h-[580px] flex flex-col justify-between`}>
            <div className="p-6">
              
              {/* STEP HEADER */}
              <div className="border-b border-slate-100 pb-4 mb-6">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#0a4d4a] bg-[#eef6f5] px-2.5 py-1 rounded-md border border-[#c3dedb]">
                  Step {currentStep} of {totalSteps}: {workflowSteps[currentStep - 1].telugu}
                </span>
                <h2 className="text-xl font-bold text-slate-900 mt-2 flex items-center gap-2">
                  {flowMode === "verify" ? (
                    <>
                      {currentStep === 1 && "Property Registration Details Form"}
                      {currentStep === 2 && "Upload the Generated Deed Document"}
                      {currentStep === 3 && "Verify Deed & Cross-Check Details"}
                    </>
                  ) : (
                    <>
                      {currentStep === 1 && "Property Registration Details Form"}
                      {currentStep === 2 && "Review Extracted & Entered Details"}
                      {currentStep === 3 && "Select Word Deed Template"}
                      {currentStep === 4 && "Auto-Fill Details into Selected Template"}
                      {currentStep === 5 && "Re-Verify Draft & Cross-Check Uploads"}
                      {currentStep === 6 && "Convert Hand Sketch to CAD-Style Plan"}
                      {currentStep === 7 && "A4 Stamp Paper Print Preview"}
                      {currentStep === 8 && "Download & Print Final Deed"}
                    </>
                  )}
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  {flowMode === "verify" ? (
                    <>
                      {currentStep === 1 && "Bilingual official details such as Pattadar Passbook, NALA Conversion, Layout approval details, bounds, seller/buyer names, and all supporting Aadhaar & Link document uploads."}
                      {currentStep === 2 && "Upload the already-generated or updated deed document (.docx or .doc). Its text is read so it can be cross-checked against the details you entered in Step 1."}
                      {currentStep === 3 && "Comprehensive AI audit: cross-checks every detail in the uploaded document against the entered data and the uploaded Aadhaar & link documents."}
                    </>
                  ) : (
                    <>
                      {currentStep === 1 && "Bilingual official details such as Pattadar Passbook, NALA Conversion, Layout approval details, bounds, seller/buyer names, and all supporting Aadhaar & Link document uploads."}
                      {currentStep === 2 && "Review every detail extracted from the Aadhaar cards and Link documents alongside the values you entered. If anything needs a fix, go back to Step 1 to adjust before drafting."}
                      {currentStep === 3 && "Select a pre-certified Word (.docx) deed template matching your registration type from the Telangana stamps template library."}
                      {currentStep === 4 && "The system merges all reviewed details into the selected Word template and formats it to the official Telangana stamp-paper layout."}
                      {currentStep === 5 && "Comprehensive AI audit: cross-checks the final deed against uploads and entered data, and confirms no residual content from other documents leaked in."}
                      {currentStep === 6 && "Upload or draw the hand sketch of the plot and let AI convert it into a clean, CAD-style boundary plan with dimensions."}
                      {currentStep === 7 && "Preview the finalized sale deed exactly as it will print — A4, Times New Roman 14, with the stamp/header space reserved on page one."}
                      {currentStep === 8 && "Download the deed as an editable Microsoft Word (.docx) or PDF, or print it directly from this page."}
                    </>
                  )}
                </p>
              </div>

              {/* AI STATUS — the app previously called setError() from 23 places
                  and rendered it NOWHERE, so any failure outside the plan step
                  was completely silent: the spinner stopped, nothing appeared,
                  and the user had no idea whether the step had worked. Both
                  banners live here, directly under the step header, so the
                  message shows up on whichever step raised it. */}
              {failure && (
                <AiStatusBanner
                  failure={failure}
                  severity="error"
                  onRetry={retryAction ?? undefined}
                  onDismiss={() => { setFailure(null); setError(null); }}
                  className="mb-5"
                />
              )}
              {degraded && (
                <AiStatusBanner
                  failure={degraded}
                  severity="warning"
                  title="Completed without AI — please review"
                  onDismiss={() => setDegraded(null)}
                  className="mb-5"
                />
              )}

              {/* PRACTICE-DATA NOTICE.
                  The preset scenarios fill every field with fictional parties
                  ("Ankem Srinivas", Aadhaar 4521 8902 3412) and mark each mock
                  file isMock: true — but that flag was written and never read
                  anywhere, and the scenario panel collapses the instant a preset
                  is clicked. So the form then looked EXACTLY like one filled from
                  real documents, which is the same "fabricated data presented as
                  real" problem the error-handling work removed from the AI paths.
                  Presets are a deliberate, clearly-labelled practice feature, so
                  the fix is to honour the flag rather than delete the feature. */}
              {activePresetId && (
                <div
                  role="status"
                  className="mb-5 border border-amber-300 bg-amber-50 rounded-xl p-3.5 flex items-start gap-2.5"
                >
                  <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-xs font-extrabold text-amber-900">
                      Practice scenario loaded — this is not real data
                    </p>
                    <p className="text-[11px] font-semibold leading-relaxed text-amber-800">
                      Every party, property and document below comes from a built-in training
                      sample with fictional names and Aadhaar numbers. Clear it before entering
                      a deed for registration.
                    </p>
                  </div>
                  {/* Clears the sample DOCUMENTS and draft plus the flag itself.
                      Deliberately does not blank the Step-1/2 text fields: by the
                      time a user dismisses this they may have already corrected
                      some of them by hand, and silently wiping real edits would
                      be its own data-loss bug. */}
                  <button
                    onClick={() => {
                      setActivePresetId(null);
                      setAadhaarCards([]);
                      setLinkDocuments([]);
                      setFilledDeedText("");
                      setReport(null);
                    }}
                    className="shrink-0 text-[11px] font-extrabold text-white bg-[#0a4d4a] hover:bg-[#0d5f5b] px-3 py-1.5 rounded cursor-pointer"
                  >
                    Clear sample data
                  </button>
                </div>
              )}

              {/* STEP CONTENTS */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentStep}
                  initial={{ opacity: 0, x: 15 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -15 }}
                  transition={{ duration: 0.15 }}
                >
                  
                  {/* STEP 1: Property Transaction Details Form (Bilingual Official Template) */}
                  {currentStep === 1 && (
                    <div className="space-y-6">

                      {/* Paper-form style wrapper */}
                      <div className="bg-white border-2 border-slate-300 rounded-xl p-4 shadow-md relative overflow-hidden font-sans w-full">

                        {/* Legal Header Styling */}
                        <div className="text-center border-b-2 border-double border-slate-400 pb-4 mb-6">
                          <h2 className="text-lg font-black text-slate-800 tracking-wide uppercase">
                            PROPERTY TRANSACTION DETAILS FORM
                          </h2>
                          <div className="text-[10px] text-slate-500 font-extrabold uppercase tracking-widest mt-0.5">
                            GOVERNMENT OF TELANGANA — REGISTRATION AND STAMPS DEPARTMENT
                          </div>
                        </div>

                        {/* JURISDICTION OF THE PROPERTY SECTION */}
                        <div className="mb-6">
                          <div className="bg-slate-700 text-white px-3 py-1 text-[11px] font-black uppercase tracking-wider rounded-t-lg border border-slate-700 flex items-center justify-between gap-1.5">
                            <div className="flex items-center gap-3">
                              <h3 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                                <MapPin className="w-3.5 h-3.5 text-slate-300" /> JURISDICTION OF THE PROPERTY (ఆస్తి ప్రాంతీయ కార్యాలయాలు)
                              </h3>
                              {jurisdictionsList.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setEditingJurisdiction(!editingJurisdiction)}
                                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase transition-colors ${
                                    editingJurisdiction
                                      ? 'bg-orange-100 text-orange-700 border border-orange-300 hover:bg-orange-200'
                                      : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                                  }`}
                                  title={editingJurisdiction ? "Click to lock editing" : "Click to edit fields"}
                                >
                                  {editingJurisdiction ? (
                                    <>
                                      <Unlock className="w-3 h-3" /> Editing
                                    </>
                                  ) : (
                                    <>
                                      <Lock className="w-3 h-3" /> Edit
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <label className="relative cursor-pointer">
                                <input
                                  type="file"
                                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                  onChange={handleLinkDocumentUpload}
                                  className="hidden"
                                  disabled={uploadingLinkDocument}
                                />
                                <span className="bg-blue-600 hover:bg-blue-700 text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1">
                                  {uploadingLinkDocument ? (
                                    <>
                                      <RefreshCw className="w-3 h-3 animate-spin" /> Processing...
                                    </>
                                  ) : (
                                    <>
                                      <UploadCloud className="w-3 h-3" /> Upload Link Document
                                    </>
                                  )}
                                </span>
                              </label>
                              <button
                                type="button"
                                onClick={addEmptyJurisdiction}
                                disabled={jurisdictionsList.some(j =>
                                  j.district === "" && j.mandal === "" && j.village === ""
                                )}
                                className="bg-[#0a4d4a] hover:bg-[#073937] disabled:bg-gray-400 disabled:cursor-not-allowed text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1 transition-colors"
                                title={jurisdictionsList.some(j => j.district === "" && j.mandal === "" && j.village === "")
                                  ? "Fill the current row before adding a new one"
                                  : "Add new jurisdiction"}
                              >
                                <Plus className="w-3 h-3" /> Add
                              </button>
                            </div>
                          </div>

                          <table className="w-full border-collapse border border-slate-300 text-xs">
                            <thead>
                              <tr className="bg-slate-50">
                                <th className="border border-slate-300 p-2 font-bold text-slate-700 text-[11px] text-left w-16">Jur.No.</th>
                                <th className="border border-slate-300 p-2 font-bold text-slate-700 text-[11px] text-left">District Registrar</th>
                                <th className="border border-slate-300 p-2 font-bold text-slate-700 text-[11px] text-left">Sub-Registrar</th>
                                <th className="border border-slate-300 p-2 font-bold text-slate-700 text-[11px] text-left">District</th>
                                <th className="border border-slate-300 p-2 font-bold text-slate-700 text-[11px] text-left">Mandal</th>
                                <th className="border border-slate-300 p-2 font-bold text-slate-700 text-[11px] text-left">Village</th>
                                <th className="border border-slate-300 p-2 font-bold text-slate-700 text-[11px] text-left">Pin Code</th>
                                <th className="border border-slate-300 p-2 font-bold text-slate-700 text-[11px] text-center w-20">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {jurisdictionsList.length === 0 ? (
                                <tr>
                                  <td colSpan={8} className="p-4 text-center text-slate-500 border border-slate-300">
                                    No jurisdiction details added yet. Click "+ Add" or "Upload Link Document" to add jurisdiction details.
                                  </td>
                                </tr>
                              ) : (
                                jurisdictionsList.map((jur, idx) => (
                                  <tr key={jur.id} className="hover:bg-slate-50">
                                    <td className="border border-slate-300 p-1 bg-slate-50 text-center font-mono text-slate-600">
                                      {idx + 1}
                                    </td>
                                    <td className="border border-slate-300 p-1">
                                      <input
                                        type="text"
                                        value={jur.districtRegistrar}
                                        onChange={(e) => updateJurisdiction(jur.id, "districtRegistrar", e.target.value)}
                                        className="w-full border-0 focus:outline-none text-xs font-semibold p-1 bg-transparent"
                                        placeholder="District Registrar"
                                      />
                                    </td>
                                    <td className="border border-slate-300 p-1">
                                      <input
                                        type="text"
                                        value={jur.subRegistrar}
                                        onChange={(e) => updateJurisdiction(jur.id, "subRegistrar", e.target.value)}
                                        className="w-full border-0 focus:outline-none text-xs font-semibold p-1 bg-transparent"
                                        placeholder="Sub-Registrar"
                                      />
                                    </td>
                                    <td className="border border-slate-300 p-1">
                                      <input
                                        type="text"
                                        value={jur.district}
                                        onChange={(e) => updateJurisdiction(jur.id, "district", e.target.value)}
                                        className="w-full border-0 focus:outline-none text-xs font-semibold p-1 bg-transparent"
                                        placeholder="District"
                                      />
                                    </td>
                                    <td className="border border-slate-300 p-1">
                                      <input
                                        type="text"
                                        value={jur.mandal}
                                        onChange={(e) => updateJurisdiction(jur.id, "mandal", e.target.value)}
                                        className="w-full border-0 focus:outline-none text-xs font-semibold p-1 bg-transparent"
                                        placeholder="Mandal"
                                      />
                                    </td>
                                    <td className="border border-slate-300 p-1">
                                      <input
                                        type="text"
                                        value={jur.village}
                                        onChange={(e) => updateJurisdiction(jur.id, "village", e.target.value)}
                                        className="w-full border-0 focus:outline-none text-xs font-semibold p-1 bg-transparent"
                                        placeholder="Village"
                                      />
                                    </td>
                                    <td className="border border-slate-300 p-1">
                                      <input
                                        type="text"
                                        value={jur.pincode}
                                        onChange={(e) => updateJurisdiction(jur.id, "pincode", e.target.value)}
                                        className="w-full border-0 focus:outline-none text-xs font-mono font-bold p-1 bg-transparent"
                                        placeholder="Pin Code"
                                      />
                                    </td>
                                    <td className="border border-slate-300 p-1 text-center">
                                      <button
                                        type="button"
                                        onClick={() => deleteJurisdiction(jur.id)}
                                        className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded transition-colors"
                                        title="Delete jurisdiction"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>

                        {/* LINK DOCUMENT DETAILS OF THE PROPERTY */}
                        <div className="mb-6">
                          <div className="flex justify-between items-center bg-slate-700 text-white px-3 py-1.5 border border-slate-700 rounded-t-lg">
                            <div className="flex items-center gap-3">
                              <h3 className="text-[11px] font-black uppercase tracking-wider flex items-center gap-1.5">
                                <FileText className="w-3.5 h-3.5 text-slate-300" /> LINK DOCUMENT DETAILS OF THE PROPERTY (లింక్ పత్రాల క్రమ వివరాలు)
                              </h3>
                              {linkDocumentsList.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setEditingLinkDocuments(!editingLinkDocuments)}
                                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase transition-colors ${
                                    editingLinkDocuments
                                      ? 'bg-orange-100 text-orange-700 border border-orange-300 hover:bg-orange-200'
                                      : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                                  }`}
                                  title={editingLinkDocuments ? "Click to lock editing" : "Click to edit fields"}
                                >
                                  {editingLinkDocuments ? (
                                    <>
                                      <Unlock className="w-3 h-3" /> Editing
                                    </>
                                  ) : (
                                    <>
                                      <Lock className="w-3 h-3" /> Edit
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <label className="relative cursor-pointer">
                                <input
                                  type="file"
                                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                  onChange={handleLinkDocumentUpload}
                                  className="hidden"
                                  disabled={uploadingLinkDocument}
                                />
                                <span className="bg-blue-600 hover:bg-blue-700 text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1">
                                  {uploadingLinkDocument ? (
                                    <>
                                      <RefreshCw className="w-3 h-3 animate-spin" /> Processing...
                                    </>
                                  ) : (
                                    <>
                                      <UploadCloud className="w-3 h-3" /> Add by Upload
                                    </>
                                  )}
                                </span>
                              </label>
                              <button
                                type="button"
                                onClick={addEmptyLinkDocument}
                                 disabled={linkDocumentsList.some(doc =>
                                   doc.layoutFileNo === "" && doc.linkDocType === "" && doc.linkDocNo === "" && doc.linkDocDate === "" &&
                                  doc.subRegistrar === "" && doc.subRegistrarCode === "" && doc.pattadarPassbookNo === "" &&
                                  doc.passbookKhataNo === "" && doc.nalaOrderNo === "" && doc.houseTaxReceipt === ""
                                )}
                                className="bg-[#0a4d4a] hover:bg-[#073937] disabled:bg-gray-400 disabled:cursor-not-allowed text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1"
                                 title={linkDocumentsList.some(doc =>
                                   doc.layoutFileNo === "" && doc.linkDocType === "" && doc.linkDocNo === "" && doc.linkDocDate === "" &&
                                  doc.subRegistrar === "" && doc.subRegistrarCode === "" && doc.pattadarPassbookNo === "" &&
                                  doc.passbookKhataNo === "" && doc.nalaOrderNo === "" && doc.houseTaxReceipt === ""
                                ) ? "Fill the current row before adding a new one" : "Add new link document"}
                              >
                                <Plus className="w-3 h-3" /> Add
                              </button>
                            </div>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse border border-slate-300 text-left">
                              <thead>
                                <tr className="bg-slate-100 border-b border-slate-300 text-[10px] text-slate-700 font-bold">
                                   <th className="p-2 border border-slate-300 w-12 text-center">Doc.No.</th>
                                   <th className="p-2 border border-slate-300 min-w-[120px]">Layout File No.</th>
                                   <th className="p-2 border border-slate-300 min-w-[150px]">Link Doc Type</th>
                                   <th className="p-2 border border-slate-300 min-w-[130px]">Link Doct.No/s</th>
                                  <th className="p-2 border border-slate-300 min-w-[120px]">Link Doct. Date</th>
                                  <th className="p-2 border border-slate-300 min-w-[120px]">Sub-Registrar</th>
                                  <th className="p-2 border border-slate-300 w-32">Sub Registrar Code</th>
                                  <th className="p-2 border border-slate-300 min-w-[140px]">Pattadar Pass Book No.</th>
                                  <th className="p-2 border border-slate-300 min-w-[130px]">Pass Book Khata No.</th>
                                  <th className="p-2 border border-slate-300 w-32">Nala Order No</th>
                                  <th className="p-2 border border-slate-300 min-w-[120px]">House Tax Receipt</th>
                                  <th className="p-2 border border-slate-300 w-16 text-center">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {linkDocumentsList.length === 0 ? (
                                  <tr>
                                    <td colSpan={12} className="p-4 text-center text-slate-500 text-sm">
                                      No link documents added yet. Click "+ Add" or "Add by Upload" to add link documents.
                                    </td>
                                  </tr>
                                ) : (
                                  linkDocumentsList.map((doc, idx) => (
                                    <tr key={doc.id} className="border-b border-slate-300 hover:bg-slate-50">
                                      <td className="p-2 border border-slate-300 text-xs font-bold text-slate-500 text-center">
                                        {idx + 1}
                                      </td>
                                       <td className="p-1 border border-slate-300">
                                         <input
                                          type="text"
                                          value={doc.layoutFileNo}
                                          onChange={(e) => updateLinkDocument(doc.id, 'layoutFileNo', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="Layout File No"
                                         />
                                       </td>
                                       <td className="p-1 border border-slate-300">
                                         <input
                                           type="text"
                                           value={doc.linkDocType}
                                           onChange={(e) => updateLinkDocument(doc.id, 'linkDocType', e.target.value)}
                                           className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                           placeholder="Sale Deed"
                                           aria-label={`Link document type for row ${idx + 1}`}
                                         />
                                       </td>
                                       <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={doc.linkDocNo}
                                          onChange={(e) => updateLinkDocument(doc.id, 'linkDocNo', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono font-bold text-slate-800 p-1"
                                          placeholder="Doc Number"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={doc.linkDocDate}
                                          onChange={(e) => updateLinkDocument(doc.id, 'linkDocDate', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono text-slate-800 p-1"
                                          placeholder="Doc Date"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={doc.subRegistrar}
                                          onChange={(e) => updateLinkDocument(doc.id, 'subRegistrar', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="Sub-Registrar"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={doc.subRegistrarCode}
                                          onChange={(e) => updateLinkDocument(doc.id, 'subRegistrarCode', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono text-slate-800 p-1"
                                          placeholder="Code"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={doc.pattadarPassbookNo}
                                          onChange={(e) => updateLinkDocument(doc.id, 'pattadarPassbookNo', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono font-bold text-slate-800 p-1"
                                          placeholder="Passbook No"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={doc.passbookKhataNo}
                                          onChange={(e) => updateLinkDocument(doc.id, 'passbookKhataNo', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono font-bold text-slate-800 p-1"
                                          placeholder="Khata No"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={doc.nalaOrderNo}
                                          onChange={(e) => updateLinkDocument(doc.id, 'nalaOrderNo', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono text-slate-800 p-1"
                                          placeholder="Nala No"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={doc.houseTaxReceipt}
                                          onChange={(e) => updateLinkDocument(doc.id, 'houseTaxReceipt', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="Tax Receipt"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300 text-center">
                                        <button
                                          type="button"
                                          onClick={() => deleteLinkDocument(doc.id)}
                                          className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded transition-colors cursor-pointer"
                                          title="Delete link document"
                                        >
                                          <Trash2 className="w-3.5 h-3.5 mx-auto" />
                                        </button>
                                      </td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* DYNAMIC PROPERTY SPECIFICATION SECTION - Tailored per Property Type */}
                        <div className="mb-6">
                          <div className="flex justify-between items-center bg-slate-100 px-3 py-1.5 border border-slate-300 rounded-t-lg flex-wrap gap-2">
                            <div className="flex items-center gap-3">
                              <h3 className="text-[10px] font-black text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                                <Building2 className="w-4 h-4" /> PROPERTY DETAILS (ఆస్తి వివరాలు)
                              </h3>
                              {propertiesList.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setEditingProperties(!editingProperties)}
                                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase transition-colors ${
                                    editingProperties
                                      ? 'bg-orange-100 text-orange-700 border border-orange-300 hover:bg-orange-200'
                                      : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                                  }`}
                                  title={editingProperties ? "Click to lock editing" : "Click to edit fields"}
                                >
                                  {editingProperties ? (
                                    <>
                                      <Unlock className="w-3 h-3" /> Editing
                                    </>
                                  ) : (
                                    <>
                                      <Lock className="w-3 h-3" /> Edit
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-[9px] font-black uppercase px-2.5 py-1 rounded flex items-center gap-1 cursor-pointer transition-colors shadow-sm">
                                <UploadCloud className="w-3 h-3" />
                                {uploadingLinkDocument ? "Extracting Details..." : "Upload Link Document"}
                                <input
                                  type="file"
                                  accept=".pdf,.png,.jpg,.jpeg"
                                  className="hidden"
                                  disabled={uploadingLinkDocument}
                                  onChange={handleLinkDocumentUpload}
                                />
                              </label>
                              <button
                                type="button"
                                onClick={addEmptyProperty}
                                className="bg-slate-700 hover:bg-slate-800 text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1 cursor-pointer"
                                title="Add new property"
                              >
                                <Plus className="w-3 h-3" /> Add Property
                              </button>
                            </div>
                          </div>

                          <div className="space-y-4 p-3 border border-t-0 border-slate-300 bg-slate-50/50 rounded-b-lg">
                            {propertiesList.length === 0 ? (
                              <div className="p-6 text-center text-slate-600 text-xs bg-white border border-dashed border-slate-300 rounded-lg flex flex-col items-center gap-2">
                                <p>No properties added yet. Click <span className="font-bold text-[#0a4d4a]">+ Add Property</span> to enter property details manually, or upload a link document to auto-extract details.</p>
                                <label className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold px-3 py-1.5 rounded flex items-center gap-1.5 cursor-pointer shadow-sm transition-all mt-1">
                                  <UploadCloud className="w-4 h-4" />
                                  {uploadingLinkDocument ? "Extracting details..." : "Upload Link Document to Auto-Extract"}
                                  <input
                                    type="file"
                                    accept=".pdf,.png,.jpg,.jpeg"
                                    className="hidden"
                                    disabled={uploadingLinkDocument}
                                    onChange={handleLinkDocumentUpload}
                                  />
                                </label>
                              </div>
                            ) : (
                              propertiesList.map((prop, idx) => (
                                <div key={prop.id} className="bg-white border border-slate-300 rounded-lg shadow-sm overflow-hidden">
                                  {/* Property Card Header */}
                                  <div className="bg-slate-100 px-3 py-2 border-b border-slate-300 flex items-center justify-between flex-wrap gap-2">
                                    <div className="flex items-center gap-2">
                                      <span className="bg-[#0a4d4a] text-white text-[10px] font-black uppercase px-2 py-0.5 rounded">
                                        Property #{idx + 1}
                                      </span>
                                      <select
                                        value={prop.propertyType}
                                        onChange={(e) => {
                                          const val = e.target.value as any;
                                          updateProperty(prop.id, 'propertyType', val);
                                          if (idx === 0) setPropertyType(val);
                                        }}
                                        className="bg-white border border-slate-300 text-xs font-bold text-slate-800 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a]"
                                      >
                                        <option value="">-- Select Property Type --</option>
                                        <option value="Open plot">Open plot</option>
                                        <option value="House">House</option>
                                        <option value="Demolished House">Demolished House</option>
                                        <option value="Part of open place">Part of open place</option>
                                        <option value="Flat">Flat</option>
                                      </select>
                                    </div>

                                    <div className="flex items-center gap-2">
                                      <label className="bg-teal-700 hover:bg-teal-800 text-white text-[10px] font-bold px-2 py-1 rounded flex items-center gap-1 cursor-pointer transition-colors">
                                        <UploadCloud className="w-3.5 h-3.5" />
                                        {uploadingLinkDocument ? "Extracting..." : "Auto-fill from Link Doc"}
                                        <input
                                          type="file"
                                          accept=".pdf,.png,.jpg,.jpeg"
                                          className="hidden"
                                          disabled={uploadingLinkDocument}
                                          onChange={handleLinkDocumentUpload}
                                        />
                                      </label>
                                      <button
                                        type="button"
                                        onClick={() => deleteProperty(prop.id)}
                                        className="bg-red-500 hover:bg-red-600 text-white px-2 py-1 rounded text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer"
                                        title="Delete Property"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" /> Remove
                                      </button>
                                    </div>
                                  </div>

                                  {/* Property Card Body */}
                                  <div className="p-4">
                                    {!prop.propertyType ? (
                                      <div className="p-4 text-center text-slate-600 text-xs bg-slate-50 border border-dashed border-slate-200 rounded flex flex-col items-center gap-2">
                                        <p className="italic">Select a property type above (Open plot, House, Demolished House, Part of open place, or Flat) to fill details manually, OR upload your link document to automatically extract and populate all property details.</p>
                                        <label className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold px-3 py-1.5 rounded flex items-center gap-1.5 cursor-pointer shadow-sm transition-all mt-1">
                                          <UploadCloud className="w-4 h-4" />
                                          {uploadingLinkDocument ? "Extracting details..." : "Upload Link Document to Auto-Fill"}
                                          <input
                                            type="file"
                                            accept=".pdf,.png,.jpg,.jpeg"
                                            className="hidden"
                                            disabled={uploadingLinkDocument}
                                            onChange={handleLinkDocumentUpload}
                                          />
                                        </label>
                                      </div>
                                    ) : prop.propertyType === "Open plot" ? (
                                      <div>
                                        <h4 className="text-xs font-black text-[#0a4d4a] uppercase tracking-wider mb-3 pb-1 border-b border-slate-200">
                                          PROPERTY DETAILS IF OPEN PLOT
                                        </h4>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Plot No/s</label>
                                            <input
                                              type="text"
                                              value={prop.plotNo}
                                              onChange={(e) => updateProperty(prop.id, 'plotNo', e.target.value)}
                                              placeholder="Plot No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Extent in Sq.yards</label>
                                            <input
                                              type="text"
                                              value={prop.extentSqYards}
                                              onChange={(e) => {
                                                const val = e.target.value;
                                                updateProperty(prop.id, 'extentSqYards', val);
                                                updateProperty(prop.id, 'extentSqMeters', squareYardsToSquareMetres(val));
                                              }}
                                              placeholder="Extent in Sq.yards"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Extent in Sq.meters</label>
                                            <input
                                              type="text"
                                              value={prop.extentSqMeters}
                                              onChange={(e) => updateProperty(prop.id, 'extentSqMeters', e.target.value)}
                                              placeholder="Extent in Sq.meters"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Survey No/s</label>
                                            <input
                                              type="text"
                                              value={prop.surveyNo}
                                              onChange={(e) => updateProperty(prop.id, 'surveyNo', e.target.value)}
                                              placeholder="Survey No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Near H.No.</label>
                                            <input
                                              type="text"
                                              value={prop.nearHNo}
                                              onChange={(e) => updateProperty(prop.id, 'nearHNo', e.target.value)}
                                              placeholder="Near H.No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Adjacent H.No.</label>
                                            <input
                                              type="text"
                                              value={prop.adjacentHNo}
                                              onChange={(e) => updateProperty(prop.id, 'adjacentHNo', e.target.value)}
                                              placeholder="Adjacent H.No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Locality</label>
                                            <input
                                              type="text"
                                              value={prop.locality}
                                              onChange={(e) => updateProperty(prop.id, 'locality', e.target.value)}
                                              placeholder="Locality"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Pincode (పిన్ కోడ్)</label>
                                            <input
                                              type="text"
                                              value={prop.pincode}
                                              onChange={(e) => updateProperty(prop.id, 'pincode', e.target.value)}
                                              placeholder="Pincode (e.g. 508211)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                           <div>
                                             <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Market Value per sq.yard</label>
                                             <input
                                               type="text"
                                               value={prop.marketValuePerSqYard}
                                               onChange={(e) => updateProperty(prop.id, 'marketValuePerSqYard', formatIndianCurrency(e.target.value))}
                                               placeholder="Market Value per sq.yard"
                                               className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono font-bold"
                                             />
                                           </div>
                                           <div>
                                             <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">V.L.T. No.</label>
                                             <input
                                               type="text"
                                               value={prop.bltNo}
                                               onChange={(e) => updateProperty(prop.id, 'bltNo', e.target.value)}
                                               placeholder="Enter V.L.T. No."
                                               className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                             />
                                           </div>
                                         </div>
                                      </div>
                                    ) : prop.propertyType === "House" ? (
                                      <div>
                                        <h4 className="text-xs font-black text-[#0a4d4a] uppercase tracking-wider mb-3 pb-1 border-b border-slate-200">
                                          PROPERTY DETAILS IF HOUSE
                                        </h4>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Plot No/s</label>
                                            <input
                                              type="text"
                                              value={prop.plotNo}
                                              onChange={(e) => updateProperty(prop.id, 'plotNo', e.target.value)}
                                              placeholder="Plot No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Extent in Sq.yards</label>
                                            <input
                                              type="text"
                                              value={prop.extentSqYards}
                                              onChange={(e) => {
                                                const val = e.target.value;
                                                updateProperty(prop.id, 'extentSqYards', val);
                                                updateProperty(prop.id, 'extentSqMeters', squareYardsToSquareMetres(val));
                                              }}
                                              placeholder="Extent in Sq.yards"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Extent in Sq.meters</label>
                                            <input
                                              type="text"
                                              value={prop.extentSqMeters}
                                              onChange={(e) => updateProperty(prop.id, 'extentSqMeters', e.target.value)}
                                              placeholder="Extent in Sq.meters"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Survey No/s</label>
                                            <input
                                              type="text"
                                              value={prop.surveyNo}
                                              onChange={(e) => updateProperty(prop.id, 'surveyNo', e.target.value)}
                                              placeholder="Survey No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Bearing H.No.</label>
                                            <input
                                              type="text"
                                              value={prop.houseBearingHNo || prop.nearHNo}
                                              onChange={(e) => {
                                                updateProperty(prop.id, 'houseBearingHNo', e.target.value);
                                                updateProperty(prop.id, 'nearHNo', e.target.value);
                                              }}
                                              placeholder="Bearing H.No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Nature of House</label>
                                            <input
                                              type="text"
                                              value={prop.houseNature}
                                              onChange={(e) => updateProperty(prop.id, 'houseNature', e.target.value)}
                                              placeholder="Nature of House (e.g. RCC / Tiled)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Floors</label>
                                            <input
                                              type="text"
                                              value={prop.houseFloors}
                                              onChange={(e) => updateProperty(prop.id, 'houseFloors', e.target.value)}
                                              placeholder="Floors (e.g. G+1)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Plinth Area</label>
                                            <input
                                              type="text"
                                              value={prop.housePlinthArea}
                                              onChange={(e) => updateProperty(prop.id, 'housePlinthArea', e.target.value)}
                                              placeholder="Plinth Area (e.g. 1500 Sq.Ft)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Locality</label>
                                            <input
                                              type="text"
                                              value={prop.locality}
                                              onChange={(e) => updateProperty(prop.id, 'locality', e.target.value)}
                                              placeholder="Locality"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Pincode (పిన్ కోడ్)</label>
                                            <input
                                              type="text"
                                              value={prop.pincode}
                                              onChange={(e) => updateProperty(prop.id, 'pincode', e.target.value)}
                                              placeholder="Pincode (e.g. 508211)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                           <div>
                                             <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Market Value per sq.yard</label>
                                             <input
                                               type="text"
                                               value={prop.marketValuePerSqYard}
                                               onChange={(e) => updateProperty(prop.id, 'marketValuePerSqYard', formatIndianCurrency(e.target.value))}
                                               placeholder="Market Value per sq.yard"
                                               className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono font-bold"
                                             />
                                           </div>
                                           <div>
                                             <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">PTI No.</label>
                                             <input
                                               type="text"
                                               value={prop.ptiNo}
                                               onChange={(e) => updateProperty(prop.id, 'ptiNo', e.target.value)}
                                               placeholder="Extracted from link document"
                                               className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                             />
                                           </div>
                                           <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Age of House</label>
                                            <input
                                              type="text"
                                              value={prop.houseAge}
                                              onChange={(e) => updateProperty(prop.id, 'houseAge', e.target.value)}
                                              placeholder="Age of House (years)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Tap Connection No.</label>
                                            <input
                                              type="text"
                                              value={prop.houseTapConnection}
                                              onChange={(e) => updateProperty(prop.id, 'houseTapConnection', e.target.value)}
                                              placeholder="Tap Connection No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Meters No/s</label>
                                            <input
                                              type="text"
                                              value={prop.houseMetersNo}
                                              onChange={(e) => updateProperty(prop.id, 'houseMetersNo', e.target.value)}
                                              placeholder="Meters No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Taxes Per Annum</label>
                                            <input
                                              type="text"
                                              value={prop.houseTaxes}
                                              onChange={(e) => updateProperty(prop.id, 'houseTaxes', e.target.value)}
                                              placeholder="Taxes Per Annum"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Annual Rental Value</label>
                                            <input
                                              type="text"
                                              value={prop.houseRentalValue}
                                              onChange={(e) => updateProperty(prop.id, 'houseRentalValue', e.target.value)}
                                              placeholder="Annual Rental Value"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                        </div>
                                      </div>
                                    ) : prop.propertyType === "Demolished House" ? (
                                      <div>
                                        <h4 className="text-xs font-black text-[#0a4d4a] uppercase tracking-wider mb-3 pb-1 border-b border-slate-200">
                                          PROPERTY DETAILS IF DEMOLISHED HOUSE
                                        </h4>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Plot No/s</label>
                                            <input
                                              type="text"
                                              value={prop.plotNo}
                                              onChange={(e) => updateProperty(prop.id, 'plotNo', e.target.value)}
                                              placeholder="Plot No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Extent in Sq.yards</label>
                                            <input
                                              type="text"
                                              value={prop.extentSqYards}
                                              onChange={(e) => {
                                                const val = e.target.value;
                                                updateProperty(prop.id, 'extentSqYards', val);
                                                updateProperty(prop.id, 'extentSqMeters', squareYardsToSquareMetres(val));
                                              }}
                                              placeholder="Extent in Sq.yards"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Extent in Sq.meters</label>
                                            <input
                                              type="text"
                                              value={prop.extentSqMeters}
                                              onChange={(e) => updateProperty(prop.id, 'extentSqMeters', e.target.value)}
                                              placeholder="Extent in Sq.meters"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Survey No/s</label>
                                            <input
                                              type="text"
                                              value={prop.surveyNo}
                                              onChange={(e) => updateProperty(prop.id, 'surveyNo', e.target.value)}
                                              placeholder="Survey No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Demolished bearing H.No.</label>
                                            <input
                                              type="text"
                                              value={prop.demoBearingHNo}
                                              onChange={(e) => updateProperty(prop.id, 'demoBearingHNo', e.target.value)}
                                              placeholder="Demolished bearing H.No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Locality</label>
                                            <input
                                              type="text"
                                              value={prop.demoLocality || prop.locality}
                                              onChange={(e) => {
                                                updateProperty(prop.id, 'demoLocality', e.target.value);
                                                updateProperty(prop.id, 'locality', e.target.value);
                                              }}
                                              placeholder="Locality"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Pincode (పిన్ కోడ్)</label>
                                            <input
                                              type="text"
                                              value={prop.pincode}
                                              onChange={(e) => updateProperty(prop.id, 'pincode', e.target.value)}
                                              placeholder="Pincode (e.g. 508211)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Market Value per sq.yard</label>
                                            <input
                                              type="text"
                                              value={prop.marketValuePerSqYard}
                                               onChange={(e) => updateProperty(prop.id, 'marketValuePerSqYard', formatIndianCurrency(e.target.value))}
                                              placeholder="Market Value per sq.yard"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono font-bold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Tap Connection No.</label>
                                            <input
                                              type="text"
                                              value={prop.demoTapConnection}
                                              onChange={(e) => updateProperty(prop.id, 'demoTapConnection', e.target.value)}
                                              placeholder="Tap Connection No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Meters No/s</label>
                                            <input
                                              type="text"
                                              value={prop.demoMetersNo}
                                              onChange={(e) => updateProperty(prop.id, 'demoMetersNo', e.target.value)}
                                              placeholder="Meters No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">P.T.I. No.</label>
                                            <input
                                              type="text"
                                              value={prop.ptiNo}
                                              onChange={(e) => updateProperty(prop.id, 'ptiNo', e.target.value)}
                                              placeholder="Enter P.T.I. No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                        </div>
                                      </div>
                                    ) : prop.propertyType === "Part of open place" ? (
                                      <div>
                                        <h4 className="text-xs font-black text-[#0a4d4a] uppercase tracking-wider mb-3 pb-1 border-b border-slate-200">
                                          PROPERTY DETAILS IF PART OF OPEN PLACE
                                        </h4>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Plot No/s</label>
                                            <input
                                              type="text"
                                              value={prop.plotNo}
                                              onChange={(e) => updateProperty(prop.id, 'plotNo', e.target.value)}
                                              placeholder="Plot No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Extent in Sq.yards</label>
                                            <input
                                              type="text"
                                              value={prop.extentSqYards}
                                              onChange={(e) => {
                                                const val = e.target.value;
                                                updateProperty(prop.id, 'extentSqYards', val);
                                                updateProperty(prop.id, 'extentSqMeters', squareYardsToSquareMetres(val));
                                              }}
                                              placeholder="Extent in Sq.yards"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Extent in Sq.meters</label>
                                            <input
                                              type="text"
                                              value={prop.extentSqMeters}
                                              onChange={(e) => updateProperty(prop.id, 'extentSqMeters', e.target.value)}
                                              placeholder="Extent in Sq.meters"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Survey No/s</label>
                                            <input
                                              type="text"
                                              value={prop.surveyNo}
                                              onChange={(e) => updateProperty(prop.id, 'surveyNo', e.target.value)}
                                              placeholder="Survey No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Part open place of bearing H.No.</label>
                                            <input
                                              type="text"
                                              value={prop.partBearingHNo}
                                              onChange={(e) => updateProperty(prop.id, 'partBearingHNo', e.target.value)}
                                              placeholder="Part open place of bearing H.No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Locality</label>
                                            <input
                                              type="text"
                                              value={prop.partLocality || prop.locality}
                                              onChange={(e) => {
                                                updateProperty(prop.id, 'partLocality', e.target.value);
                                                updateProperty(prop.id, 'locality', e.target.value);
                                              }}
                                              placeholder="Locality"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Pincode (పిన్ కోడ్)</label>
                                            <input
                                              type="text"
                                              value={prop.pincode}
                                              onChange={(e) => updateProperty(prop.id, 'pincode', e.target.value)}
                                              placeholder="Pincode (e.g. 508211)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Market Value per sq.yard</label>
                                            <input
                                              type="text"
                                              value={prop.marketValuePerSqYard}
                                               onChange={(e) => updateProperty(prop.id, 'marketValuePerSqYard', formatIndianCurrency(e.target.value))}
                                              placeholder="Market Value per sq.yard"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono font-bold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">P.T.I. No.</label>
                                            <input
                                              type="text"
                                              value={prop.ptiNo}
                                              onChange={(e) => updateProperty(prop.id, 'ptiNo', e.target.value)}
                                              placeholder="Enter P.T.I. No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                        </div>
                                      </div>
                                    ) : prop.propertyType === "Flat" ? (
                                      <div>
                                        <h4 className="text-xs font-black text-[#0a4d4a] uppercase tracking-wider mb-3 pb-1 border-b border-slate-200">
                                          PROPERTY DETAILS IF FLAT
                                        </h4>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Flat No/s</label>
                                            <input
                                              type="text"
                                              value={prop.flatNo}
                                              onChange={(e) => updateProperty(prop.id, 'flatNo', e.target.value)}
                                              placeholder="Flat No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Undivided share land in Sq.yards</label>
                                            <input
                                              type="text"
                                              value={prop.flatUndividedSqYards}
                                              onChange={(e) => {
                                                const val = e.target.value;
                                                updateProperty(prop.id, 'flatUndividedSqYards', val);
                                                updateProperty(prop.id, 'flatUndividedSqMeters', squareYardsToSquareMetres(val));
                                              }}
                                              placeholder="UDS in Sq.yards"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Undivided share land in Sq.meters</label>
                                            <input
                                              type="text"
                                              value={prop.flatUndividedSqMeters}
                                              onChange={(e) => updateProperty(prop.id, 'flatUndividedSqMeters', e.target.value)}
                                              placeholder="UDS in Sq.meters"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Survey No/s</label>
                                            <input
                                              type="text"
                                              value={prop.surveyNo}
                                              onChange={(e) => updateProperty(prop.id, 'surveyNo', e.target.value)}
                                              placeholder="Survey No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-semibold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Bearing H.No.</label>
                                            <input
                                              type="text"
                                              value={prop.flatBearingHNo}
                                              onChange={(e) => updateProperty(prop.id, 'flatBearingHNo', e.target.value)}
                                              placeholder="Bearing H.No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Nature of House</label>
                                            <input
                                              type="text"
                                              value={prop.flatNature}
                                              onChange={(e) => updateProperty(prop.id, 'flatNature', e.target.value)}
                                              placeholder="Nature of House (e.g. Residential Apartment)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Locality</label>
                                            <input
                                              type="text"
                                              value={prop.flatLocality}
                                              onChange={(e) => updateProperty(prop.id, 'flatLocality', e.target.value)}
                                              placeholder="Locality"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Pincode (పిన్ కోడ్)</label>
                                            <input
                                              type="text"
                                              value={prop.pincode}
                                              onChange={(e) => updateProperty(prop.id, 'pincode', e.target.value)}
                                              placeholder="Pincode (e.g. 508211)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Market Value per sq.feet</label>
                                            <input
                                              type="text"
                                              value={prop.flatValuePerSqFeet}
                                               onChange={(e) => updateProperty(prop.id, 'flatValuePerSqFeet', formatIndianCurrency(e.target.value))}
                                              placeholder="Market Value per sq.feet"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono font-bold"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Age of Flat</label>
                                            <input
                                              type="text"
                                              value={prop.flatAge}
                                              onChange={(e) => updateProperty(prop.id, 'flatAge', e.target.value)}
                                              placeholder="Age of Flat (years)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Tap Connection No.</label>
                                            <input
                                              type="text"
                                              value={prop.flatTapConnection}
                                              onChange={(e) => updateProperty(prop.id, 'flatTapConnection', e.target.value)}
                                              placeholder="Tap Connection No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Meters No/s</label>
                                            <input
                                              type="text"
                                              value={prop.flatMetersNo}
                                              onChange={(e) => updateProperty(prop.id, 'flatMetersNo', e.target.value)}
                                              placeholder="Meters No/s"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Taxes Per Annum</label>
                                            <input
                                              type="text"
                                              value={prop.flatTaxes}
                                              onChange={(e) => updateProperty(prop.id, 'flatTaxes', e.target.value)}
                                              placeholder="Taxes Per Annum"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Annual Rental Value</label>
                                            <input
                                              type="text"
                                              value={prop.flatRentalValue}
                                              onChange={(e) => updateProperty(prop.id, 'flatRentalValue', e.target.value)}
                                              placeholder="Annual Rental Value"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Building Name</label>
                                            <input
                                              type="text"
                                              value={prop.flatBuildingName}
                                              onChange={(e) => updateProperty(prop.id, 'flatBuildingName', e.target.value)}
                                              placeholder="Building Name"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Near H.No.</label>
                                            <input
                                              type="text"
                                              value={prop.flatNearHNo}
                                              onChange={(e) => updateProperty(prop.id, 'flatNearHNo', e.target.value)}
                                              placeholder="Near H.No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Floor/s</label>
                                            <input
                                              type="text"
                                              value={prop.flatFloorS}
                                              onChange={(e) => updateProperty(prop.id, 'flatFloorS', e.target.value)}
                                              placeholder="Floor (e.g. 2nd Floor)"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Plinth Area</label>
                                            <input
                                              type="text"
                                              value={prop.flatPlinthArea}
                                              onChange={(e) => updateProperty(prop.id, 'flatPlinthArea', e.target.value)}
                                              placeholder="Plinth Area in Sq.Ft"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Total land</label>
                                            <input
                                              type="text"
                                              value={prop.flatTotalLand}
                                              onChange={(e) => updateProperty(prop.id, 'flatTotalLand', e.target.value)}
                                              placeholder="Total land"
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a]"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">P.T.I. No.</label>
                                            <input
                                              type="text"
                                              value={prop.ptiNo}
                                              onChange={(e) => updateProperty(prop.id, 'ptiNo', e.target.value)}
                                              placeholder="Enter P.T.I. No."
                                              className="w-full border border-slate-300 rounded p-1.5 focus:ring-1 focus:ring-[#0a4d4a] font-mono"
                                            />
                                          </div>
                                        </div>
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                        {/* BOUNDARIES SECTION */}
                        <div>
                          <div className="flex justify-between items-center bg-[#1e40af] text-white px-3 py-1.5 border border-[#1e40af] rounded-t-lg">
                            <div className="flex items-center gap-3">
                              <h3 className="text-[11px] font-black uppercase tracking-wider flex items-center gap-1.5">
                                <BookOpen className="w-3.5 h-3.5 text-blue-200" /> BOUNDARIES (సరిహద్దుల వివరాలు)
                              </h3>
                              {boundariesList.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setEditingBoundaries(!editingBoundaries)}
                                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase transition-colors ${
                                    editingBoundaries
                                      ? 'bg-orange-100 text-orange-700 border border-orange-300 hover:bg-orange-200'
                                      : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                                  }`}
                                  title={editingBoundaries ? "Click to lock editing" : "Click to edit fields"}
                                >
                                  {editingBoundaries ? (
                                    <>
                                      <Unlock className="w-3 h-3" /> Editing
                                    </>
                                  ) : (
                                    <>
                                      <Lock className="w-3 h-3" /> Edit
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={addEmptyBoundary}
                              disabled={boundariesList.some(b => b.east === "" && b.west === "" && b.north === "" && b.south === "")}
                              className="bg-[#1e40af] hover:bg-[#1e3a8a] disabled:bg-gray-400 disabled:cursor-not-allowed text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1"
                              title={boundariesList.some(b => b.east === "" && b.west === "" && b.north === "" && b.south === "") ? "Fill the current row before adding a new one" : "Add new boundary set"}
                            >
                              <Plus className="w-3 h-3" /> Add
                            </button>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse border border-slate-300 text-left">
                              <thead>
                                <tr className="bg-slate-100 border-b border-slate-300 text-[10px] text-slate-700 font-bold">
                                  <th className="p-2 border border-slate-300 w-12 text-center">Set No.</th>
                                  <th className="p-2 border border-slate-300 min-w-[200px]">East (తూర్పు)</th>
                                  <th className="p-2 border border-slate-300 min-w-[200px]">West (పడమర)</th>
                                  <th className="p-2 border border-slate-300 min-w-[200px]">North (ఉత్తరం)</th>
                                  <th className="p-2 border border-slate-300 min-w-[200px]">South (దక్షిణం)</th>
                                  <th className="p-2 border border-slate-300 w-16 text-center">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {boundariesList.length === 0 ? (
                                  <tr>
                                    <td colSpan={6} className="p-4 text-center text-slate-500 text-sm">
                                      No boundaries added yet. Click "+ Add" to add boundary details.
                                    </td>
                                  </tr>
                                ) : (
                                  boundariesList.map((boundary, idx) => (
                                    <tr key={boundary.id} className="border-b border-slate-300 hover:bg-slate-50">
                                      <td className="p-2 border border-slate-300 text-xs font-bold text-slate-500 text-center">
                                        {idx + 1}
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={boundary.east}
                                          onChange={(e) => updateBoundary(boundary.id, 'east', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="East boundary"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={boundary.west}
                                          onChange={(e) => updateBoundary(boundary.id, 'west', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="West boundary"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={boundary.north}
                                          onChange={(e) => updateBoundary(boundary.id, 'north', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="North boundary"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={boundary.south}
                                          onChange={(e) => updateBoundary(boundary.id, 'south', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="South boundary"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300 text-center">
                                        <button
                                          type="button"
                                          onClick={() => deleteBoundary(boundary.id)}
                                          className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded transition-colors cursor-pointer"
                                          title="Delete boundary set"
                                        >
                                          <Trash2 className="w-3.5 h-3.5 mx-auto" />
                                        </button>
                                      </td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* Top Financials Section: Market Value, Stamps, Nature of Transaction */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 bg-slate-50 p-4 border border-slate-300 rounded-lg mt-6">
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] font-black text-slate-700 uppercase">
                              Market Value of Rs. <span className="text-red-600">*</span>
                            </span>
                            <div className="relative">
                              <span className="absolute left-2.5 top-2 text-xs font-bold text-slate-400">₹</span>
                              <input
                                type="text"
                                value={marketValue}
                                onChange={(e) => setMarketValue(formatIndianCurrency(e.target.value))}
                                className="w-full pl-6 pr-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono font-bold text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-[#0a4d4a]"
                                placeholder="Market value amount"
                              />
                            </div>
                          </div>

                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] font-black text-slate-700 uppercase">
                              Stamps of Rs. <span className="text-red-600">*</span>
                            </span>
                            <div className="relative">
                              <span className="absolute left-2.5 top-2 text-xs font-bold text-slate-400">₹</span>
                              <input
                                type="text"
                                value={stampsAmount}
                                onChange={(e) => setStampsAmount(formatIndianCurrency(e.target.value))}
                                className="w-full pl-6 pr-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono font-bold text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-[#0a4d4a]"
                                placeholder="Stamp duty amount"
                              />
                            </div>
                          </div>

                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] font-black text-slate-700 uppercase">
                              Nature of Transaction <span className="text-red-600">*</span>
                            </span>
                            <input
                              type="text"
                              value={natureOfTransaction}
                              onChange={(e) => setNatureOfTransaction(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-bold text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] placeholder:font-normal placeholder:text-slate-400"
                              placeholder="Enter Nature of Transaction (e.g. Sale Deed, Gift Deed)..."
                            />
                          </div>
                        </div>

                        {/* DETAILS OF EXECUTANTS SECTION */}
                        <div className="mb-6">
                          <div className="flex justify-between items-center bg-[#0a4d4a]/10 px-3 py-1.5 border border-[#0a4d4a]/30 rounded-t-lg">
                            <div className="flex items-center gap-3">
                              <h3 className="text-xs font-black text-[#0a4d4a] uppercase tracking-wider flex items-center gap-1.5">
                                <UserCheck className="w-4 h-4 text-[#0a4d4a]" /> DETAILS OF EXECUTANTS (విక్రేతల వివరాలు)
                              </h3>
                              {executantsList.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setEditingExecutants(!editingExecutants)}
                                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase transition-colors ${
                                    editingExecutants
                                      ? 'bg-orange-100 text-orange-700 border border-orange-300 hover:bg-orange-200'
                                      : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                                  }`}
                                  title={editingExecutants ? "Click to lock editing" : "Click to edit fields"}
                                >
                                  {editingExecutants ? (
                                    <>
                                      <Unlock className="w-3 h-3" /> Editing
                                    </>
                                  ) : (
                                    <>
                                      <Lock className="w-3 h-3" /> Edit
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <label
                                className="relative cursor-pointer"
                                title="Upload an Aadhaar card (front and/or back). Front has name, DOB & number; back has relation & address — upload both and they merge into one entry. PDF, JPG or PNG."
                              >
                                <input
                                  type="file"
                                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                  onChange={handleAadhaarUploadExecutant}
                                  className="hidden"
                                  disabled={uploadingAadhaarExecutant}
                                />
                                <span className="bg-blue-600 hover:bg-blue-700 text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1">
                                  {uploadingAadhaarExecutant ? (
                                    <>
                                      <RefreshCw className="w-3 h-3 animate-spin" /> Extracting...
                                    </>
                                  ) : (
                                    <>
                                      <UploadCloud className="w-3 h-3" /> Add by Aadhaar
                                    </>
                                  )}
                                </span>
                              </label>
                              <button
                                type="button"
                                onClick={addEmptyExecutant}
                                disabled={executantsList.some(e => e.name === "" && e.aadhaarNo === "" && e.address === "")}
                                className="bg-[#0a4d4a] hover:bg-[#073937] disabled:bg-gray-400 disabled:cursor-not-allowed text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1"
                                title={executantsList.some(e => e.name === "" && e.aadhaarNo === "" && e.address === "") ? "Fill the current row before adding a new one" : "Add new executant"}
                              >
                                <Plus className="w-3 h-3" /> Add
                              </button>
                            </div>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse border border-slate-300 text-left">
                              <thead>
                                <tr className="bg-slate-100 border-b border-slate-300 text-[10px] text-slate-700 font-bold">
                                  <th className="p-2 border border-slate-300 w-12 text-center">Ex.No.</th>
                                  <th className="p-2 border border-slate-300 min-w-[150px]">Name of Executant/s</th>
                                  <th className="p-2 border border-slate-300 min-w-[145px]">Relationship Name (S/o, W/o, D/o)</th>
                                  <th className="p-2 border border-slate-300 w-36">Date of Birth</th>
                                  <th className="p-2 border border-slate-300 w-16 text-center">Age</th>
                                  <th className="p-2 border border-slate-300 min-w-[180px]">Resident Address</th>
                                  <th className="p-2 border border-slate-300 w-28">Occupation</th>
                                  <th className="p-2 border border-slate-300 w-32">Cell No.</th>
                                  <th className="p-2 border border-slate-300 w-36">Adhar No/s</th>
                                  <th className="p-2 border border-slate-300 w-16 text-center">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {executantsList.length === 0 ? (
                                  <tr>
                                    <td colSpan={10} className="p-4 text-center text-slate-500 text-sm">
                                      No executants added yet. Click "+ Add" to enter manually, or "Add by Aadhaar" to auto-fill from a card.
                                      <span className="block text-[11px] text-slate-400 mt-1">Tip: upload both the front and back of the Aadhaar — they'll be combined into one entry.</span>
                                    </td>
                                  </tr>
                                ) : (
                                  executantsList.map((exec, idx) => (
                                  <tr key={exec.id} className="border-b border-slate-300 hover:bg-slate-50">
                                    <td className="p-2 border border-slate-300 text-xs font-bold text-slate-500 text-center">
                                      {idx + 1}
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={exec.name}
                                        onChange={(e) => {
                                          const updated = [...executantsList];
                                          updated[idx].name = e.target.value;
                                          setExecutantsList(updated);
                                          if (idx === 0) setExecutantName(e.target.value);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-bold text-slate-800 p-1"
                                        placeholder="Full Name"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={exec.relation || ""}
                                        onChange={(e) => {
                                          const updated = [...executantsList];
                                          updated[idx].relation = e.target.value;
                                          setExecutantsList(updated);
                                          if (idx === 0) setExecutantRelation(e.target.value);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-bold text-slate-800 p-1"
                                        placeholder="S/o or W/o Name"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="date"
                                        value={exec.dob || ""}
                                        onChange={(e) => {
                                          const dobVal = e.target.value;
                                          const calculatedAge = calculateAgeFromDOB(dobVal);
                                          const updated = [...executantsList];
                                          updated[idx].dob = dobVal;
                                          updated[idx].age = calculatedAge;
                                          setExecutantsList(updated);
                                          if (idx === 0) {
                                            setExecutantDOB(dobVal);
                                            setExecutantAge(Number(calculatedAge) || 0);
                                          }
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs text-slate-800 p-1 font-mono"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="number"
                                        value={exec.age || ""}
                                        onChange={(e) => {
                                          const updated = [...executantsList];
                                          updated[idx].age = e.target.value;
                                          setExecutantsList(updated);
                                          if (idx === 0) setExecutantAge(Number(e.target.value) || 0);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono font-bold text-slate-800 p-1 text-center bg-slate-50/60"
                                        placeholder="Age"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={exec.address || ""}
                                        onChange={(e) => {
                                          const updated = [...executantsList];
                                          updated[idx].address = e.target.value;
                                          setExecutantsList(updated);
                                          if (idx === 0) setExecutantAddress(e.target.value);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                        placeholder="Residential Address"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={exec.occupation}
                                        onChange={(e) => {
                                          const updated = [...executantsList];
                                          updated[idx].occupation = e.target.value;
                                          setExecutantsList(updated);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                        placeholder="Business / Agr"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={exec.cellNo}
                                        onChange={(e) => {
                                          const updated = [...executantsList];
                                          updated[idx].cellNo = e.target.value;
                                          setExecutantsList(updated);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono text-slate-800 p-1"
                                        placeholder="Mobile phone"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={exec.aadhaarNo}
                                        onChange={(e) => {
                                          const updated = [...executantsList];
                                          updated[idx].aadhaarNo = e.target.value;
                                          setExecutantsList(updated);
                                          if (idx === 0) setExecutantAadhaar(e.target.value);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono font-bold text-slate-800 p-1"
                                        placeholder="12-digit Aadhaar"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300 text-center">
                                      <button
                                        type="button"
                                        onClick={() => deleteExecutant(exec.id)}
                                        className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded transition-colors cursor-pointer"
                                        title="Delete executant"
                                      >
                                        <Trash2 className="w-3.5 h-3.5 mx-auto" />
                                      </button>
                                    </td>
                                  </tr>
                                ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* DETAILS OF CLAIMANTS SECTION */}
                        <div className="mb-6">
                          <div className="flex justify-between items-center bg-[#1e40af]/10 px-3 py-1.5 border border-[#1e40af]/30 rounded-t-lg">
                            <h3 className="text-xs font-black text-[#1e40af] uppercase tracking-wider flex items-center gap-1.5">
                              <UserCheck className="w-4 h-4 text-[#1e40af]" /> DETAILS OF CLAIMANTS (కొనుగోలుదారుల వివరాలు)
                            </h3>
                            <div className="flex gap-2">
                              <label
                                className="relative cursor-pointer"
                                title="Upload an Aadhaar card (front and/or back). Front has name, DOB & number; back has relation & address — upload both and they merge into one entry. PDF, JPG or PNG."
                              >
                                <input
                                  type="file"
                                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                  onChange={handleAadhaarUploadClaimant}
                                  className="hidden"
                                  disabled={uploadingAadhaarClaimant}
                                />
                                <span className="bg-blue-600 hover:bg-blue-700 text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1">
                                  {uploadingAadhaarClaimant ? (
                                    <>
                                      <RefreshCw className="w-3 h-3 animate-spin" /> Extracting...
                                    </>
                                  ) : (
                                    <>
                                      <UploadCloud className="w-3 h-3" /> Add by Aadhaar
                                    </>
                                  )}
                                </span>
                              </label>
                              <button
                                type="button"
                                onClick={addEmptyClaimant}
                                disabled={claimantsList.some(c => c.name === "" && c.aadhaarNo === "" && c.address === "")}
                                className="bg-[#1e40af] hover:bg-[#1e3a8a] disabled:bg-gray-400 disabled:cursor-not-allowed text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1"
                                title={claimantsList.some(c => c.name === "" && c.aadhaarNo === "" && c.address === "") ? "Fill the current row before adding a new one" : "Add new claimant"}
                              >
                                <Plus className="w-3 h-3" /> Add
                              </button>
                            </div>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse border border-slate-300 text-left">
                              <thead>
                                <tr className="bg-slate-100 border-b border-slate-300 text-[10px] text-slate-700 font-bold">
                                  <th className="p-2 border border-slate-300 w-12 text-center">Cl.No.</th>
                                  <th className="p-2 border border-slate-300 min-w-[150px]">Name of Claimant/s</th>
                                  <th className="p-2 border border-slate-300 min-w-[145px]">Relationship Name (S/o, W/o, D/o)</th>
                                  <th className="p-2 border border-slate-300 w-36">Date of Birth</th>
                                  <th className="p-2 border border-slate-300 w-16 text-center">Age</th>
                                  <th className="p-2 border border-slate-300 min-w-[180px]">Resident Address</th>
                                  <th className="p-2 border border-slate-300 w-28">Occupation</th>
                                  <th className="p-2 border border-slate-300 w-32">Cell No.</th>
                                  <th className="p-2 border border-slate-300 w-36">Adhar No/s</th>
                                  <th className="p-2 border border-slate-300 w-16 text-center">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {claimantsList.length === 0 ? (
                                  <tr>
                                    <td colSpan={10} className="p-4 text-center text-slate-500 text-sm">
                                      No claimants added yet. Click "+ Add" to enter manually, or "Add by Aadhaar" to auto-fill from a card.
                                      <span className="block text-[11px] text-slate-400 mt-1">Tip: upload both the front and back of the Aadhaar — they'll be combined into one entry.</span>
                                    </td>
                                  </tr>
                                ) : (
                                  claimantsList.map((claim, idx) => (
                                  <tr key={claim.id} className="border-b border-slate-300 hover:bg-slate-50">
                                    <td className="p-2 border border-slate-300 text-xs font-bold text-slate-500 text-center">
                                      {idx + 1}
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={claim.name}
                                        onChange={(e) => {
                                          const updated = [...claimantsList];
                                          updated[idx].name = e.target.value;
                                          setClaimantsList(updated);
                                          if (idx === 0) setClaimantName(e.target.value);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-bold text-slate-800 p-1"
                                        placeholder="Full Name"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={claim.relation || ""}
                                        onChange={(e) => {
                                          const updated = [...claimantsList];
                                          updated[idx].relation = e.target.value;
                                          setClaimantsList(updated);
                                          if (idx === 0) setClaimantRelation(e.target.value);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-bold text-slate-800 p-1"
                                        placeholder="S/o or W/o Name"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="date"
                                        value={claim.dob || ""}
                                        onChange={(e) => {
                                          const dobVal = e.target.value;
                                          const calculatedAge = calculateAgeFromDOB(dobVal);
                                          const updated = [...claimantsList];
                                          updated[idx].dob = dobVal;
                                          updated[idx].age = calculatedAge;
                                          setClaimantsList(updated);
                                          if (idx === 0) {
                                            setClaimantDOB(dobVal);
                                            setClaimantAge(Number(calculatedAge) || 0);
                                          }
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs text-slate-800 p-1 font-mono"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="number"
                                        value={claim.age || ""}
                                        onChange={(e) => {
                                          const updated = [...claimantsList];
                                          updated[idx].age = e.target.value;
                                          setClaimantsList(updated);
                                          if (idx === 0) setClaimantAge(Number(e.target.value) || 0);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-mono font-bold text-slate-800 p-1 text-center bg-slate-50/60"
                                        placeholder="Age"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={claim.address || ""}
                                        onChange={(e) => {
                                          const updated = [...claimantsList];
                                          updated[idx].address = e.target.value;
                                          setClaimantsList(updated);
                                          if (idx === 0) setClaimantAddress(e.target.value);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-semibold text-slate-800 p-1"
                                        placeholder="Residential Address"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={claim.occupation}
                                        onChange={(e) => {
                                          const updated = [...claimantsList];
                                          updated[idx].occupation = e.target.value;
                                          setClaimantsList(updated);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-semibold text-slate-800 p-1"
                                        placeholder="Business / Agr"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={claim.cellNo}
                                        onChange={(e) => {
                                          const updated = [...claimantsList];
                                          updated[idx].cellNo = e.target.value;
                                          setClaimantsList(updated);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-mono text-slate-800 p-1"
                                        placeholder="Mobile phone"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300">
                                      <input
                                        type="text"
                                        value={claim.aadhaarNo}
                                        onChange={(e) => {
                                          const updated = [...claimantsList];
                                          updated[idx].aadhaarNo = e.target.value;
                                          setClaimantsList(updated);
                                          if (idx === 0) setClaimantAadhaar(e.target.value);
                                        }}
                                        className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#1e40af] text-xs font-mono font-bold text-slate-800 p-1"
                                        placeholder="12-digit Aadhaar"
                                      />
                                    </td>
                                    <td className="p-1 border border-slate-300 text-center">
                                      <button
                                        type="button"
                                        onClick={() => deleteClaimant(claim.id)}
                                        className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded transition-colors cursor-pointer"
                                        title="Delete claimant"
                                      >
                                        <Trash2 className="w-3.5 h-3.5 mx-auto" />
                                      </button>
                                    </td>
                                  </tr>
                                ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* VERIFY FLOW — STEP 2: upload the already-generated deed document */}
                  {flowMode === "verify" && currentStep === 2 && (
                    <div className="space-y-5">
                      <div className="p-3.5 bg-[#eef6f5] border border-[#c3dedb] rounded-lg text-[11px] text-[#0a4d4a] flex items-start gap-2.5">
                        <Info className="w-4 h-4 shrink-0 mt-0.5" />
                        <p>
                          Upload the deed document that was already generated or updated (Microsoft Word
                          <span className="font-bold"> .docx</span> or <span className="font-bold">.doc</span>). Its text is read
                          so the next step can cross-check every detail against the registration details you entered in Step 1
                          and the uploaded Aadhaar &amp; link documents.
                        </p>
                      </div>

                      <label
                        className={`flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                          verifyDocName
                            ? "border-emerald-300 bg-emerald-50/40"
                            : "border-slate-300 bg-slate-50 hover:border-[#0a4d4a] hover:bg-[#eef6f5]"
                        }`}
                      >
                        <input
                          type="file"
                          accept=".docx,.doc"
                          className="hidden"
                          onChange={handleVerifyDocumentUpload}
                        />
                        {verifyDocParsing ? (
                          <>
                            <div className="relative w-12 h-12 flex items-center justify-center">
                              <div className="absolute inset-0 border-4 border-[#eef6f5] rounded-full"></div>
                              <div className="absolute inset-0 border-4 border-[#0a4d4a] border-t-transparent rounded-full animate-spin"></div>
                            </div>
                            <p className="text-xs font-bold text-slate-600">Reading document…</p>
                          </>
                        ) : verifyDocName ? (
                          <>
                            <FileCheck2 className="w-12 h-12 text-emerald-600" />
                            <div>
                              <p className="text-sm font-bold text-slate-800">{verifyDocName}</p>
                              <p className="text-[11px] text-slate-500 mt-0.5">
                                Loaded successfully — click to replace with a different document.
                              </p>
                            </div>
                          </>
                        ) : (
                          <>
                            <FileUp className="w-12 h-12 text-[#0a4d4a]/40" />
                            <div>
                              <p className="text-sm font-bold text-slate-700">Click to upload the generated deed</p>
                              <p className="text-[11px] text-slate-500 mt-0.5">Microsoft Word .docx or .doc</p>
                            </div>
                          </>
                        )}
                      </label>

                      {verifyDocName && filledDeedText && (
                        <div className="border border-slate-200 rounded-xl overflow-hidden">
                          <div className="bg-slate-50 border-b border-slate-200 px-4 py-2 flex items-center gap-1.5">
                            <FileText className="w-3.5 h-3.5 text-[#0a4d4a]" />
                            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                              Uploaded Document Preview
                            </span>
                          </div>
                          <pre className="p-4 text-[11px] text-slate-700 whitespace-pre-wrap max-h-[280px] overflow-y-auto font-sans leading-relaxed">
                            {filledDeedText}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}

                  {/* VERIFY FLOW — STEP 3: cross-check audit (reuses the generate flow's audit logic) */}
                  {flowMode === "verify" && currentStep === 3 && (
                    <div className="space-y-5">
                      {auditing ? (
                        <div className="flex flex-col items-center justify-center text-center p-8">
                          <div className="w-full space-y-4">
                            <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
                              <div className="absolute inset-0 border-4 border-[#eef6f5] rounded-full"></div>
                              <div className="absolute inset-0 border-4 border-[#0a4d4a] border-t-transparent rounded-full animate-spin"></div>
                              <FileCheck2 className="w-6 h-6 text-[#0a4d4a] animate-pulse" />
                            </div>
                            <div>
                              <h4 className="font-bold text-slate-800 text-sm">Running Comprehensive Deed Verification…</h4>
                              <p className="text-xs text-slate-400 mt-1">Cross-checking the uploaded document against entered data and uploaded Aadhaar &amp; link documents.</p>
                            </div>
                            <div className="max-w-md mx-auto bg-slate-50 border border-slate-200 rounded-lg p-3 text-left font-mono text-[10px] text-slate-500 space-y-1">
                              {auditingStepsLogs.map((log, idx) => {
                                const isCompleted = idx < auditStepIndex;
                                const isCurrent = idx === auditStepIndex;
                                return (
                                  <p key={idx} className={`${isCompleted ? "text-emerald-600 font-semibold" : isCurrent ? "text-[#0a4d4a] font-bold" : "text-slate-300"}`}>
                                    {isCompleted ? "✓" : isCurrent ? "●" : "○"} {log}
                                  </p>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      ) : report ? (() => {
                        const discs = report.allDiscrepancies || [];
                        const clamp = (z: number) => Math.min(1.6, Math.max(0.6, Math.round(z * 100) / 100));
                        return (
                        <div className="space-y-4">
                          {/* Status banner + zoom / re-run toolbar */}
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className={`px-3 py-2 rounded-lg text-white text-[11px] font-bold flex items-center gap-2 ${report.summary.status === "APPROVED" ? "bg-emerald-800" : "bg-red-800"}`}>
                              {report.summary.status === "APPROVED" ? "ALL CLEAR · అన్నీ సరిగ్గా ఉన్నాయి" : "DISCREPANCIES DETECTED · తేడాలు గుర్తించబడ్డాయి"}
                              <span className="bg-white/15 px-2 py-0.5 rounded border border-white/20 font-mono">{discs.length} Issues</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button onClick={() => setReportZoom((z) => clamp(z - 0.1))} title="Zoom out" className="w-8 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-bold flex items-center justify-center">−</button>
                              <span className="text-[11px] font-bold text-slate-600 w-12 text-center tabular-nums">{Math.round(reportZoom * 100)}%</span>
                              <button onClick={() => setReportZoom((z) => clamp(z + 0.1))} title="Zoom in" className="w-8 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-bold flex items-center justify-center">+</button>
                              <button onClick={() => setReportZoom(1)} title="Reset zoom" className="ml-1 px-2.5 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-600 text-[11px] font-bold">Fit</button>
                              <button onClick={triggerDeedVerificationAudit} className="ml-1 px-3 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-[11px] font-bold flex items-center gap-1.5">
                                <RefreshCw className="w-3.5 h-3.5" /> Re-run
                              </button>
                              <button onClick={printVerificationReport} title="Print report" className="px-3 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-[11px] font-bold flex items-center gap-1.5">
                                <Printer className="w-3.5 h-3.5" /> Print
                              </button>
                            </div>
                          </div>

                          {/* Word-style A4 page holding the 5-column discrepancy table */}
                          <div className="bg-slate-200/60 border border-slate-300 rounded-xl p-4 sm:p-6 overflow-auto max-h-[70vh]">
                            <div
                              className="bg-white shadow-lg mx-auto origin-top"
                              style={{ width: "794px", minHeight: "1123px", padding: "48px 40px", transform: `scale(${reportZoom})`, transformOrigin: "top center" }}
                            >
                              {/* Report header */}
                              <div className="text-center border-b-2 border-double border-slate-400 pb-4 mb-5">
                                <h2 className="text-xl font-black text-slate-800 tracking-wide uppercase">Deed Verification Report</h2>
                                <p className="text-sm font-bold text-[#0a4d4a] mt-0.5">దస్తావేజు పరిశీలన నివేదిక</p>
                              </div>
                              <div className="text-[12px] text-slate-600 space-y-1 mb-5">
                                {verifyDocName && <p><span className="font-bold">Document / పత్రం:</span> {verifyDocName}</p>}
                                <p><span className="font-bold">Registration Date / తేదీ:</span> {registrationDate || "—"}</p>
                                <p><span className="font-bold">Discrepancies found / గుర్తించిన తేడాలు:</span> <span className="font-bold text-red-700">{discs.length}</span></p>
                              </div>

                              {discs.length === 0 ? (
                                <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-4 text-[13px] text-emerald-800 font-semibold">
                                  No discrepancies detected — the document matches the entered details and uploaded documents.
                                  <span className="block text-[12px] text-emerald-700 mt-1 font-sans">ఎటువంటి తేడాలు కనుగొనబడలేదు — పత్రం నమోదు వివరాలతో సరిపోలింది.</span>
                                </div>
                              ) : (
                                <table className="w-full border-collapse text-[12px] table-fixed">
                                  <colgroup>
                                    <col style={{ width: "20%" }} /><col style={{ width: "30%" }} /><col style={{ width: "19%" }} /><col style={{ width: "19%" }} /><col style={{ width: "12%" }} />
                                  </colgroup>
                                  <thead>
                                    <tr className="bg-[#0a4d4a] text-white">
                                      {[["Category", "వర్గం"], ["Issue", "సమస్య"], ["In Document", "పత్రంలో ఉన్నది"], ["Should Be", "ఉండవలసినది"], ["Severity", "తీవ్రత"]].map((h, i) => (
                                        <th key={i} className="border border-[#0a4d4a] px-2 py-2 text-left align-top">
                                          <div className="font-bold leading-tight">{h[0]}</div>
                                          <div className="font-semibold text-[10px] text-[#bfe3df] font-sans">{h[1]}</div>
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {discs.map((item: any, idx: number) => {
                                      const isCritical = String(item.severity || "").toUpperCase() === "CRITICAL";
                                      const teluguCat = getTeluguCategory(item.category);
                                      const teluguDesc = item.descriptionTe || getTeluguDescription(item.description);
                                      return (
                                        <tr key={idx} className={isCritical ? "bg-red-50/60" : "bg-amber-50/50"}>
                                          <td className="border border-slate-300 px-2 py-2 align-top">
                                            <div className="font-bold text-slate-800">{item.category || "—"}</div>
                                            {teluguCat && <div className="text-[11px] text-[#0a4d4a] font-sans">{teluguCat}</div>}
                                          </td>
                                          <td className="border border-slate-300 px-2 py-2 align-top">
                                            <div className="text-slate-800">{item.description || "—"}</div>
                                            {teluguDesc && <div className="text-[11px] text-[#0a4d4a] font-sans mt-0.5">{teluguDesc}</div>}
                                          </td>
                                          <td className="border border-slate-300 px-2 py-2 align-top font-bold text-red-700 break-words">{item.found || "—"}</td>
                                          <td className="border border-slate-300 px-2 py-2 align-top font-bold text-emerald-700 break-words">{item.expected || "—"}</td>
                                          <td className="border border-slate-300 px-2 py-2 align-top text-center">
                                            <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${isCritical ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
                                              {(item.severity || "").toUpperCase()}
                                            </span>
                                            <div className="text-[10px] font-semibold mt-1 font-sans text-slate-600">{isCritical ? "తీవ్రమైనది" : "హెచ్చరిక"}</div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </div>

                          {/* Downloads */}
                          <div className="border-t border-slate-200 pt-4 flex flex-wrap justify-center gap-3">
                            <button
                              onClick={downloadVerificationReport}
                              disabled={reportDownloading !== ""}
                              className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 text-white text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 shadow-sm"
                            >
                              <Download className="w-4 h-4" /> {reportDownloading === "report" ? "Preparing…" : "Download Report (Word)"}
                            </button>
                            <button
                              onClick={downloadCorrectedDeed}
                              disabled={reportDownloading !== ""}
                              className="bg-white border border-[#0a4d4a] text-[#0a4d4a] hover:bg-[#eef6f5] disabled:opacity-50 text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 shadow-sm"
                            >
                              <Download className="w-4 h-4" /> {reportDownloading === "corrected" ? "Preparing…" : "Download Corrected Deed (Word)"}
                            </button>
                            <button
                              onClick={printVerificationReport}
                              className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 shadow-sm"
                            >
                              <Printer className="w-4 h-4" /> Print Report
                            </button>
                          </div>
                          <p className="text-[10px] text-slate-400 text-center max-w-lg mx-auto">
                            The corrected deed is your uploaded document with a <span className="font-semibold">Suggested Corrections / సూచించిన సవరణలు</span> section appended at the bottom — review each change before use.
                          </p>
                        </div>
                        );
                      })() : (
                        <div className="flex flex-col items-center justify-center text-center p-8 space-y-5">
                          <ShieldCheck className="w-16 h-16 text-[#0a4d4a]/20 mx-auto" />
                          <div>
                            <h4 className="font-bold text-slate-800">Verify the Uploaded Deed Document</h4>
                            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                              A deep AI audit cross-checks every detail in the uploaded document against the details you entered in
                              Step 1 and the uploaded Aadhaar &amp; link documents.
                            </p>
                          </div>
                          {!filledDeedText.trim() ? (
                            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900 max-w-md mx-auto flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                              <span>No document loaded yet. Go back to Step 2 and upload the generated deed (.docx/.doc) first.</span>
                            </div>
                          ) : (
                            <button onClick={triggerDeedVerificationAudit} className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 mx-auto">
                              <FileCheck2 className="w-4 h-4" /> Run Comprehensive Verification
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* STEP 2: File Upload states (Aadhaar & Link Documents) */}
                  {flowMode === "generate" && currentStep === 2 && (() => {
                    const review = buildConsolidatedDetails();
                    const Field = ({ label, value }: { label: string; value?: string }) => (
                      <div className="flex flex-col">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
                        <span className="text-[13px] text-slate-900 font-medium">{value && String(value).trim() ? value : <span className="text-slate-300 italic">—</span>}</span>
                      </div>
                    );
                    return (
                      <div className="space-y-5">
                        {/* Instruction banner */}
                        <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900 flex items-start gap-2.5">
                          <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          <p>
                            Review every value extracted from your Aadhaar cards & link documents alongside what you entered.
                            If anything is wrong, use <span className="font-bold">Previous Step</span> to return to the form and correct it before drafting the deed.
                          </p>
                        </div>

                        {/* Blank-page document-style review sheet */}
                        <div className="bg-white border border-slate-300 rounded-xl shadow-sm mx-auto w-full max-w-3xl">
                          <div className="border-b-2 border-[#0a4d4a] px-8 py-5 text-center">
                            <h2 className="text-lg font-extrabold text-[#0a4d4a] tracking-wide uppercase">Sale Deed — Consolidated Details Review</h2>
                            <p className="text-[11px] text-slate-500 mt-1">
                              {natureOfTransaction || "Sale"} · {propertyType || "Property"} · Registration Date: {registrationDate || "—"}
                            </p>
                          </div>

                          <div className="px-8 py-6 space-y-7">
                            {/* Executants / Sellers */}
                            <section>
                              <h3 className="text-xs font-extrabold text-[#0a4d4a] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-slate-200 pb-1.5">
                                <UserCheck className="w-4 h-4" /> Executant(s) — Seller(s) &nbsp;<span className="text-slate-400 font-bold">({review.executants.length})</span>
                              </h3>
                              {review.executants.length === 0 ? (
                                <p className="text-[12px] text-slate-400 italic">No executant details captured yet.</p>
                              ) : (
                                <div className="space-y-4">
                                  {review.executants.map((e: any, i: number) => (
                                    <div key={i} className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 p-3 bg-slate-50/70 border border-slate-100 rounded-lg">
                                      <Field label="Name" value={e.name} />
                                      <Field label="Relation (S/o, W/o, D/o)" value={e.relation} />
                                      <Field label="Age" value={e.age ? String(e.age) : ""} />
                                       <Field label="Aadhaar No" value={e.aadhaar} />
                                       <Field label="PAN" value={e.pan} />
                                       <Field label="Date of Birth" value={e.dob} />
                                       <Field label="Occupation" value={e.occupation} />
                                       <Field label="Mobile No" value={e.cellNo} />
                                       <div className="col-span-2 md:col-span-3"><Field label="Address" value={e.address} /></div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </section>

                            {/* Claimants / Buyers */}
                            <section>
                              <h3 className="text-xs font-extrabold text-[#0a4d4a] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-slate-200 pb-1.5">
                                <UserCheck className="w-4 h-4" /> Claimant(s) — Buyer(s) &nbsp;<span className="text-slate-400 font-bold">({review.claimants.length})</span>
                              </h3>
                              {review.claimants.length === 0 ? (
                                <p className="text-[12px] text-slate-400 italic">No claimant details captured yet.</p>
                              ) : (
                                <div className="space-y-4">
                                  {review.claimants.map((c: any, i: number) => (
                                    <div key={i} className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 p-3 bg-slate-50/70 border border-slate-100 rounded-lg">
                                      <Field label="Name" value={c.name} />
                                      <Field label="Relation (S/o, W/o, D/o)" value={c.relation} />
                                      <Field label="Age" value={c.age ? String(c.age) : ""} />
                                       <Field label="Aadhaar No" value={c.aadhaar} />
                                       <Field label="PAN" value={c.pan} />
                                       <Field label="Date of Birth" value={c.dob} />
                                       <Field label="Occupation" value={c.occupation} />
                                       <Field label="Mobile No" value={c.cellNo} />
                                       <div className="col-span-2 md:col-span-3"><Field label="Address" value={c.address} /></div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </section>

                            {/* Property schedule */}
                            <section>
                              <h3 className="text-xs font-extrabold text-[#0a4d4a] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-slate-200 pb-1.5">
                                <MapPin className="w-4 h-4" /> Schedule of Property
                              </h3>
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
                                 <Field label="Survey No" value={review.property.surveyNo} />
                                 <Field label="Property Type" value={review.property.propertyType} />
                                 <Field label="H. No" value={review.property.hNo} />
                                 <Field label="Plot No" value={review.property.plotNo} />
                                 <Field label="PTI / Passbook No" value={review.property.ptiNo} />
                                 <Field label="V.L.T. No" value={review.property.bltNo} />
                                 <Field label="Extent (Sq. Yards)" value={review.property.extentSqYards} />
                                 <Field label="Extent (Sq. Metres)" value={review.property.extentSqMeters} />
                                 <Field label="Plinth Area" value={review.property.plinthArea} />
                                 <Field label="Adjacent H. No" value={review.property.adjacentHNo} />
                                 <Field label="Locality" value={review.property.locality || review.property.demoLocality || review.property.partLocality || review.property.flatLocality} />
                                 <Field label="Pincode" value={review.property.pincode} />
                                 <Field label="Market Value per Sq. Yard" value={review.property.marketValuePerSqYard} />
                                 <Field label="Village" value={review.property.village} />
                                <Field label="Mandal" value={review.property.mandal} />
                                <Field label="District" value={review.property.district} />
                                <Field label="State" value={review.property.state} />
                                <Field label="Market Value (Rs.)" value={review.marketValue} />
                                 <Field label="Stamp Duty (Rs.)" value={review.stampsAmount} />
                               </div>
                               <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 mt-4 pt-4 border-t border-slate-100">
                                 <Field label="House Nature" value={review.property.houseNature} />
                                 <Field label="House Floors" value={review.property.houseFloors} />
                                 <Field label="House Age" value={review.property.houseAge} />
                                 <Field label="Tap Connection" value={review.property.houseTapConnection || review.property.demoTapConnection || review.property.flatTapConnection} />
                                 <Field label="Meter No" value={review.property.houseMetersNo || review.property.demoMetersNo || review.property.flatMetersNo} />
                                 <Field label="Annual Taxes" value={review.property.houseTaxes || review.property.flatTaxes} />
                                 <Field label="Annual Rental Value" value={review.property.houseRentalValue || review.property.flatRentalValue} />
                                 <Field label="Flat No" value={review.property.flatNo} />
                                 <Field label="Flat Building Name" value={review.property.flatBuildingName} />
                                 <Field label="Flat Floor" value={review.property.flatFloorS} />
                                 <Field label="Flat UDS (Sq. Yards)" value={review.property.flatUndividedSqYards} />
                                 <Field label="Flat UDS (Sq. Metres)" value={review.property.flatUndividedSqMeters} />
                                 <Field label="Flat Value per Sq. Ft" value={review.property.flatValuePerSqFeet} />
                                 <Field label="Flat Total Market Value" value={review.property.flatMarketValueTotal} />
                                 <Field label="Total Land" value={review.property.flatTotalLand} />
                               </div>
                             </section>

                            {/* Boundaries */}
                            <section>
                              <h3 className="text-xs font-extrabold text-[#0a4d4a] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-slate-200 pb-1.5">
                                <MapPin className="w-4 h-4" /> Boundaries (Schedule)
                              </h3>
                              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                                <Field label="East by" value={review.property.boundaries.east} />
                                <Field label="West by" value={review.property.boundaries.west} />
                                <Field label="North by" value={review.property.boundaries.north} />
                                <Field label="South by" value={review.property.boundaries.south} />
                              </div>
                             </section>

                             {/* Jurisdiction */}
                             <section>
                               <h3 className="text-xs font-extrabold text-[#0a4d4a] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-slate-200 pb-1.5">
                                 <MapPin className="w-4 h-4" /> Registration Jurisdiction
                               </h3>
                               {review.jurisdictions.length === 0 ? (
                                 <p className="text-[12px] text-slate-400 italic">No jurisdiction details captured yet.</p>
                               ) : review.jurisdictions.map((jurisdiction: any, i: number) => (
                                 <div key={i} className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 p-3 bg-slate-50/70 border border-slate-100 rounded-lg mb-3">
                                   <Field label="District Registrar" value={jurisdiction.districtRegistrar} />
                                   <Field label="Sub-Registrar" value={jurisdiction.subRegistrar} />
                                   <Field label="District" value={jurisdiction.district} />
                                   <Field label="Mandal" value={jurisdiction.mandal} />
                                   <Field label="Village" value={jurisdiction.village} />
                                   <Field label="Pincode" value={jurisdiction.pincode} />
                                 </div>
                               ))}
                             </section>

                            {/* Link document */}
                            <section>
                              <h3 className="text-xs font-extrabold text-[#0a4d4a] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-slate-200 pb-1.5">
                                <BookOpen className="w-4 h-4" /> Link / Acquisition Document
                              </h3>
                               <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
                                 <Field label="Link Doc Type" value={review.linkDeed.docType} />
                                 <Field label="Link Deed No" value={review.linkDeed.deedNumber} />
                                <Field label="Link Deed Date" value={review.linkDeed.executionDate} />
                                <Field label="Sub-Registrar Office" value={review.linkDeed.village} />
                                <Field label="SRO / Sub-Registrar Code" value={review.linkDeed.subRegistrarCode} />
                                <Field label="Layout File No" value={review.linkDeed.layoutFileNo} />
                                <Field label="Pattadar Passbook No" value={review.linkDeed.pattadarPassbookNo} />
                                <Field label="Passbook Khata No" value={review.linkDeed.passbookKhataNo} />
                                <Field label="NALA Order No" value={review.linkDeed.nalaOrderNo} />
                                <Field label="House Tax Receipt" value={review.linkDeed.houseTaxReceipt} />
                                <Field label="Nature of Transaction" value={review.natureOfTransaction} />
                              </div>
                            </section>

                            {/* Uploaded source documents */}
                            <section>
                              <h3 className="text-xs font-extrabold text-[#0a4d4a] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-slate-200 pb-1.5">
                                <FileText className="w-4 h-4" /> Source Documents Uploaded
                              </h3>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Aadhaar / PAN cards ({aadhaarCards.length})</p>
                                  {aadhaarCards.length === 0 ? (
                                    <p className="text-[11px] text-slate-300 italic">None uploaded</p>
                                  ) : (
                                    <ul className="space-y-1">
                                      {aadhaarCards.map((c, i) => (
                                        <li key={i} className="text-[11px] text-slate-700 flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" /> {c.name}</li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                                <div>
                                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Link documents ({linkDocuments.length})</p>
                                  {linkDocuments.length === 0 ? (
                                    <p className="text-[11px] text-slate-300 italic">None uploaded</p>
                                  ) : (
                                    <ul className="space-y-1">
                                      {linkDocuments.map((l, i) => (
                                        <li key={i} className="text-[11px] text-slate-700 flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" /> {l.name}</li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            </section>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* STEP 3: Select predefined Word (.docx) template */}
                  {flowMode === "generate" && currentStep === 3 && (
                    <div className="space-y-5">
                      <div className="p-3.5 bg-[#eef6f5] border border-[#c3dedb] rounded-lg text-[11px] text-[#0a4d4a] flex items-start gap-2.5">
                        <Info className="w-4 h-4 shrink-0 mt-0.5" />
                        <p>
                          Choose a pre-certified Word (.docx) deed template that matches your registration type, <span className="font-bold">or upload your own
                          template document</span> below. In the next step, all reviewed details are merged into the selected template and formatted to the
                          official Telangana stamp-paper layout.
                        </p>
                      </div>

                      {/* RE-AUDIT (Feature #4): cross-check the entered Step 1/2 data against the
                          uploaded Aadhaar/link documents BEFORE spending an AI call to auto-fill
                          the template in Step 4. No deed draft exists yet at this point, so this
                          audits the ENTERED DATA itself, not a draft. */}
                      <div className="p-4 rounded-xl border border-slate-200 bg-white space-y-3">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div>
                            <h4 className="font-extrabold text-[13px] text-slate-900 flex items-center gap-1.5">
                              <Search className="w-4 h-4 text-[#0a4d4a]" /> Re-Audit Entered Details
                            </h4>
                            <p className="text-[11px] text-slate-500 mt-1 max-w-md">
                              Cross-checks the names, Aadhaar numbers, ages, and property/boundary details you entered in Step 1
                              against the uploaded Aadhaar cards and Link Document — catching mismatches before they get merged into the draft.
                            </p>
                          </div>
                          <button
                            onClick={triggerPreAudit}
                            disabled={preAuditing || (aadhaarCards.length === 0 && linkDocuments.length === 0)}
                            title={aadhaarCards.length === 0 && linkDocuments.length === 0 ? "Upload an Aadhaar card or Link document in Step 1 to enable this check." : undefined}
                            className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold py-2 px-4 rounded-lg flex items-center gap-1.5 shadow-sm shrink-0"
                          >
                            {preAuditing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                            {preAuditing ? "Auditing…" : "Re-Audit"}
                          </button>
                        </div>

                        {preAuditReport && (
                          <div className="space-y-2.5 pt-1">
                            <div className={`p-3 rounded-lg text-white flex justify-between items-center ${preAuditReport.summary?.status === "APPROVED" ? "bg-emerald-800" : "bg-red-800"}`}>
                              <div>
                                <h5 className="font-bold text-[11px] uppercase">
                                  {preAuditReport.summary?.status === "APPROVED" ? "All Clear" : "Discrepancies Found"}
                                </h5>
                                <p className="text-[10px] text-white/80 mt-0.5">{preAuditReport.summary?.message}</p>
                              </div>
                              <div className="text-lg font-extrabold">{preAuditReport.summary?.discrepancyCount ?? 0}</div>
                            </div>
                            {(preAuditReport.allDiscrepancies || []).length > 0 && (
                              <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                                {preAuditReport.allDiscrepancies.map((item: any, idx: number) => (
                                  <div key={idx} className="p-2.5 bg-red-50/50 border border-red-200 rounded-lg text-[11px] space-y-1.5">
                                    <div className="flex items-center justify-between gap-2 flex-wrap">
                                      <span className="text-[9px] bg-red-100 text-red-800 font-black px-2 py-0.5 rounded-full uppercase">
                                        {item.severity}
                                      </span>
                                      <span className="text-[10px] text-slate-600 font-bold bg-white px-2 py-0.5 rounded border border-slate-200">
                                        {item.category}
                                      </span>
                                    </div>
                                    <p className="font-bold text-slate-900 leading-snug">{item.description}</p>
                                    <div className="grid grid-cols-2 gap-2 text-[10px] bg-white p-2 rounded-md border border-slate-200">
                                      <div>
                                        <span className="text-slate-500 block font-bold uppercase text-[9px]">EXPECTED:</span>
                                        <span className="text-emerald-700 font-black font-mono text-[11px]">{item.expected}</span>
                                      </div>
                                      <div>
                                        <span className="text-slate-500 block font-bold uppercase text-[9px]">FOUND:</span>
                                        <span className="text-red-600 font-black font-mono text-[11px]">{item.found}</span>
                                      </div>
                                    </div>
                                    <p className="text-[10px] text-amber-900 bg-amber-50/60 p-1.5 rounded-md border border-amber-200">
                                      <strong>Recommendation:</strong> {item.recommendation}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* TEMPLATE-LIBRARY STATUS.
                          There is no manual library picker on this step — loadTemplates()
                          auto-selects a template matching the property type. So when the
                          load FAILS, selectedTemplateId stays "" and the Proceed button
                          reads "Select a template first" with nothing on screen to select,
                          which is an unexplained dead end. `templatesLoading` was tracked
                          but never rendered, so the loading, failed and empty cases all
                          looked identical. These two lines make each one distinguishable
                          and point the user at the upload card below as a way forward. */}
                      {templatesLoading ? (
                        <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-500 px-1">
                          <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#0a4d4a]" />
                          Loading the certified template library…
                        </div>
                      ) : serverTemplates.length === 0 ? (
                        <div className="flex items-start gap-2 text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                          <span>
                            The certified template library could not be loaded, so no template is pre-selected.
                            You can still continue by uploading your own .docx template below.
                            {failure?.retryable && retryAction && (
                              <button
                                onClick={retryAction}
                                className="ml-1.5 underline font-extrabold text-[#0a4d4a] hover:text-[#0d5f5b] cursor-pointer"
                              >
                                Retry loading
                              </button>
                            )}
                          </span>
                        </div>
                      ) : null}

                      {/* Bring-your-own: upload a custom .docx/.doc/.txt template */}
                      <div className={`p-4 rounded-xl border-2 transition-all ${selectedTemplateId === CUSTOM_TEMPLATE_ID ? "border-[#0a4d4a] bg-[#eef6f5] shadow-sm" : "border-dashed border-slate-300 bg-white"}`}>
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div className="flex items-start gap-2.5">
                            <div className={`p-1.5 rounded-lg ${selectedTemplateId === CUSTOM_TEMPLATE_ID ? "bg-[#0a4d4a] text-white" : "bg-slate-100 text-slate-500"}`}>
                              <UploadCloud className="w-4 h-4" />
                            </div>
                            <div>
                              <h4 className="font-extrabold text-[13px] text-slate-900 leading-tight">Upload Your Own Template</h4>
                              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed max-w-md">
                                Bring your own pre-templated deed — <span className="font-semibold">Microsoft Word .docx only</span>.
                                We merge the details extracted in Step 1 directly into your document, preserving its exact tables, headings, fonts and page layout.
                                <span className="text-slate-400"> Save older .doc files as .docx in Word before uploading.</span>
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {selectedTemplateId === CUSTOM_TEMPLATE_ID && <CheckCircle2 className="w-5 h-5 text-[#0a4d4a]" />}
                            <label className={`cursor-pointer bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold py-2 px-4 rounded-lg flex items-center gap-1.5 ${customTemplateLoading ? "opacity-60 pointer-events-none" : ""}`}>
                              {customTemplateLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                              {customTemplateLoading ? "Reading…" : customTemplateName ? "Replace File" : "Browse…"}
                              <input
                                type="file"
                                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                className="hidden"
                                onChange={handleCustomTemplateUpload}
                              />
                            </label>
                          </div>
                        </div>
                        {customTemplateName && (
                          <div className="mt-3 flex items-center gap-2 text-[11px] bg-white border border-[#c3dedb] rounded-lg px-3 py-2">
                            <FileCheck2 className="w-4 h-4 text-[#0a4d4a] shrink-0" />
                            <span className="font-bold text-slate-700 truncate">{customTemplateName}</span>
                            <span className="text-slate-400">· {customTemplateText.length.toLocaleString()} chars loaded</span>
                            <button
                              type="button"
                              onClick={() => {
                                setCustomTemplateText("");
                                setCustomTemplateName("");
                                if (selectedTemplateId === CUSTOM_TEMPLATE_ID) {
                                  setSelectedTemplateId(serverTemplates[0]?.id || "");
                                }
                              }}
                              className="ml-auto text-slate-400 hover:text-red-500"
                              title="Remove uploaded template"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* STEP 4: Auto-fill details into the selected template */}
                  {currentStep === 4 && (
                    <>
                      {filling ? (
                        <div className="flex flex-col items-center justify-center text-center p-8">
                          <div className="space-y-4">
                            <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
                              <div className="absolute inset-0 border-4 border-[#eef6f5] rounded-full"></div>
                              <div className="absolute inset-0 border-4 border-[#0a4d4a] border-t-transparent rounded-full animate-spin"></div>
                              <RefreshCw className="w-6 h-6 text-[#0a4d4a] animate-spin" />
                            </div>
                            <div>
                              <h4 className="font-bold text-slate-800">Merging your details into the template…</h4>
                              <p className="text-xs text-slate-400 mt-1">The AI is reading the template, deciding where each person and property detail belongs, and overwriting the placeholder/specimen values with your Step-1 details.</p>
                            </div>
                          </div>
                        </div>
                      ) : filledDeedText ? (
                        /* GENERATED DOCUMENT — shown in full, on this step, for review */
                        <div className="space-y-4">
                          <div className="p-3.5 bg-[#eef6f5] border border-[#c3dedb] rounded-lg text-[11px] text-[#0a4d4a] flex items-start gap-2.5">
                            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                            <p>
                              Your details have been merged into{" "}
                              <span className="font-bold">{selectedTemplateName()}</span>. Review the full generated document
                              below — every party, property, and transaction detail from Step 1 has been written into the template’s
                              own wording. You can edit any text here; changes carry through to verification and download.
                            </p>
                          </div>

                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                                <FileText className="w-3.5 h-3.5" /> Generated Document
                              </span>
                              {mergeMode === "ai" && (
                                <span className="text-[9px] font-bold uppercase tracking-wide bg-[#0a4d4a] text-white px-2 py-0.5 rounded-full flex items-center gap-1">
                                  <Sparkles className="w-2.5 h-2.5" /> AI-merged
                                </span>
                              )}
                              {mergeMode === "deterministic" && (
                                <span className="text-[9px] font-bold uppercase tracking-wide bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
                                  Placeholder-merged
                                </span>
                              )}
                              <span className="text-[10px] text-slate-400">{filledDeedText.length.toLocaleString()} chars</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {filledDeedText && (
                                <button
                                  type="button"
                                  onClick={togglePreviewEditing}
                                  title={previewEditing ? "Finish editing and return to the live document preview" : "Edit the full document text"}
                                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border transition-colors ${
                                    previewEditing
                                      ? "bg-orange-100 text-orange-700 border-orange-300 hover:bg-orange-200"
                                      : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"
                                  }`}
                                >
                                  {previewEditing ? (<><Unlock className="w-3.5 h-3.5" /> Editing — click to preview</>) : (<><Edit2 className="w-3.5 h-3.5" /> Edit text</>)}
                                </button>
                              )}
                              <button
                                onClick={() => generateDocument(false)}
                                disabled={!selectedTemplateId}
                                className="bg-white border border-slate-300 hover:bg-slate-100 disabled:opacity-50 text-slate-700 text-xs font-bold py-2 px-4 rounded-lg flex items-center gap-1.5"
                              >
                                <RefreshCw className="w-3.5 h-3.5" /> Regenerate
                              </button>
                              {/* Feature #5: on-demand Telugu translation, downloaded as its own
                                  standalone .docx (Sree Krushnadevaraya font) — separate from the
                                  English deed above, which is left untouched. */}
                              <button
                                onClick={translateDeedToTelugu}
                                disabled={teluguTranslating || !filledDeedText.trim()}
                                title="Translate this deed into Telugu and download it as a separate Word document, set in the Sree Krushnadevaraya Telugu font."
                                className="bg-white border border-[#0a4d4a] text-[#0a4d4a] hover:bg-[#eef6f5] disabled:opacity-50 disabled:cursor-not-allowed text-xs font-bold py-2 px-4 rounded-lg flex items-center gap-1.5"
                              >
                                {teluguTranslating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                                {teluguTranslating ? "Translating…" : "Translate to Telugu"}
                              </button>
                            </div>
                          </div>

                          {teluguDocxBase64 && !teluguTranslating && (
                            <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-[11px] text-emerald-900 flex items-center gap-2">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              <span>
                                Telugu translation downloaded as a separate Word document (Sree Krushnadevaraya font).{" "}
                                <button
                                  type="button"
                                  onClick={() =>
                                    downloadBase64(
                                      teluguDocxBase64,
                                      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                      `Telugu_Translation_${(claimantsList[0]?.name || claimantName || "deed").replace(/\s+/g, "_")}.docx`
                                    )
                                  }
                                  className="font-bold underline underline-offset-2 hover:text-emerald-700"
                                >
                                  Download again
                                </button>
                              </span>
                            </div>
                          )}

                          {unresolvedPlaceholders.length > 0 && (
                            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900">
                              <p className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Unfilled placeholders detected ({unresolvedPlaceholders.length})</p>
                              <p className="mt-1 font-mono break-words">{unresolvedPlaceholders.join(", ")}</p>
                              <p className="mt-1">These values were missing from Step 1. Go back to supply them, then Regenerate — or fill them directly in the document below.</p>
                            </div>
                          )}

                          {/* Full document content. When a filled .docx is available (and not
                              editing), show the REAL Word document via the SAME shared preview
                              component used by Step 7 (Stamp Preview) — real tables, centered/bold
                              headings, correct fonts and true page breaks, i.e. exactly what
                              downloads. Editing (or a render failure) falls back to the A4-styled
                              editable text. */}
                          {(!previewEditing && !!generatedDocxBase64 && !docxPreviewError) ? (
                            <DocxLivePreview
                              docxBase64={generatedDocxBase64}
                              maxHeightClass="max-h-[560px]"
                              onError={() => setDocxPreviewError(true)}
                            />
                          ) : (
                            <div className="flex justify-center bg-slate-100 rounded-xl p-6 overflow-y-auto max-h-[560px]">
                              <div
                                className="bg-white shadow-lg relative"
                                style={{ width: "210mm", minHeight: "220mm", padding: "1in 0.75in", boxSizing: "border-box" }}
                              >
                                <textarea
                                  value={filledDeedText}
                                  onChange={(e) => handleDeedTextEdit(e.target.value)}
                                  className="w-full bg-transparent border-none p-0 outline-none focus:ring-0 resize-none"
                                  style={{ fontFamily: "'Times New Roman', Times, serif", fontSize: "14pt", lineHeight: 1.5, color: "#000", minHeight: "200mm", whiteSpace: "pre-wrap" }}
                                />
                              </div>
                            </div>
                          )}

                          <div className="flex justify-center">
                            <button onClick={() => setCurrentStep(5)} className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold py-2.5 px-6 rounded-lg flex items-center gap-1.5">
                              Looks Good — Proceed to Re-Verify <ArrowRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center text-center p-8">
                          <div className="space-y-5">
                            <FileText className="w-16 h-16 text-[#0a4d4a]/20 mx-auto" />
                            <div>
                              <h4 className="font-bold text-slate-800">Auto-Fill the Selected Template</h4>
                              <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                                Template selected:{" "}
                                <span className="font-bold text-[#0a4d4a]">
                                  {selectedTemplateName()}
                                </span>.
                                The AI will read the template, merge in every detail from Step 1, and generate the full document right here for you to review.
                              </p>
                            </div>
                            <button onClick={() => generateDocument(false)} disabled={!selectedTemplateId} className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 text-white text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 mx-auto">
                              <Sparkles className="w-4 h-4" /> Generate &amp; Preview Here
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* STEP 5: Comprehensive Re-Verify of the drafted deed */}
                  {currentStep === 5 && (
                    <div className="space-y-5">
                      {auditing ? (
                        <div className="flex flex-col items-center justify-center text-center p-8">
                          <div className="w-full space-y-4">
                            <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
                              <div className="absolute inset-0 border-4 border-[#eef6f5] rounded-full"></div>
                              <div className="absolute inset-0 border-4 border-[#0a4d4a] border-t-transparent rounded-full animate-spin"></div>
                              <FileCheck2 className="w-6 h-6 text-[#0a4d4a] animate-pulse" />
                            </div>
                            <div>
                              <h4 className="font-bold text-slate-800 text-sm">Running Comprehensive Deed Verification…</h4>
                              <p className="text-xs text-slate-400 mt-1">Cross-checking documents, entered data, and the final deed — and scanning for residual content from other properties.</p>
                            </div>
                            <div className="max-w-md mx-auto bg-slate-50 border border-slate-200 rounded-lg p-3 text-left font-mono text-[10px] text-slate-500 space-y-1">
                              {auditingStepsLogs.map((log, idx) => {
                                const isCompleted = idx < auditStepIndex;
                                const isCurrent = idx === auditStepIndex;
                                return (
                                  <p key={idx} className={`${isCompleted ? "text-emerald-600 font-semibold" : isCurrent ? "text-[#0a4d4a] font-bold" : "text-slate-300"}`}>
                                    {isCompleted ? "✓" : isCurrent ? "●" : "○"} {log}
                                  </p>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      ) : report ? (
                        <div className="space-y-4">
                          <div className={`p-4 rounded-xl text-white flex justify-between items-center ${report.summary.status === "APPROVED" ? "bg-emerald-800" : "bg-red-800"}`}>
                            <div>
                              <h4 className="font-bold text-xs uppercase">Verification: {report.summary.status === "APPROVED" ? "ALL CLEAR" : "DISCREPANCIES DETECTED"}</h4>
                              <p className="text-[11px] text-white/80 mt-0.5">{report.summary.message}</p>
                            </div>
                            <span className="bg-white/10 px-3 py-1 rounded-lg border border-white/20 text-xs font-bold font-mono">
                              {report.summary.discrepancyCount} Issues
                            </span>
                          </div>

                          {unresolvedPlaceholders.length > 0 && (
                            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900">
                              <p className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Unfilled placeholders detected ({unresolvedPlaceholders.length})</p>
                              <p className="mt-1 font-mono break-words">{unresolvedPlaceholders.join(", ")}</p>
                              <p className="mt-1">Go back to Step 1 to supply the missing values, then re-generate the document.</p>
                            </div>
                          )}

                          {report.allDiscrepancies?.length > 0 && (
                            <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                              {report.allDiscrepancies.map((item: any, idx: number) => {
                                const teluguCat = getTeluguCategory(item.category);
                                const teluguDesc = item.descriptionTe || getTeluguDescription(item.description);
                                return (
                                  <div key={idx} className="p-3 bg-red-50/50 border border-red-100 rounded-lg text-[11px] space-y-1.5">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[9px] bg-red-100 text-red-800 font-bold px-2 py-0.5 rounded-full uppercase">
                                        {item.severity} ({item.severity === "CRITICAL" ? "తీవ్రమైనది" : "హెచ్చరిక"})
                                      </span>
                                      <span className="text-[10px] text-slate-500 font-bold">
                                        {item.category} {teluguCat && <span className="text-[#0a4d4a]">· {teluguCat}</span>}
                                      </span>
                                    </div>
                                    <p className="font-extrabold text-slate-800">{item.description}</p>
                                    {teluguDesc && (
                                      <p className="text-[10px] text-[#0a4d4a] font-semibold bg-emerald-50/70 p-1.5 rounded border border-emerald-100 font-sans">
                                        <strong>తెలుగు:</strong> {teluguDesc}
                                      </p>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          <div className="flex justify-center gap-3 pt-2">
                            <button onClick={triggerDeedVerificationAudit} className="bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold py-2.5 px-5 rounded-lg flex items-center gap-1.5">
                              <RefreshCw className="w-4 h-4" /> Re-run Verification
                            </button>
                            <button onClick={() => setCurrentStep(6)} className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold py-2.5 px-6 rounded-lg flex items-center gap-1.5">
                              Proceed to Generate Plan <ArrowRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center text-center p-8 space-y-5">
                          <FileCheck2 className="w-16 h-16 text-[#0a4d4a]/20 mx-auto" />
                          <div>
                            <h4 className="font-bold text-slate-800">Comprehensive Deed Re-Verification</h4>
                            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                              A deep AI audit cross-checks the uploaded documents, the details you entered in Step 1, and the generated deed —
                              and confirms <span className="font-bold">no residual content</span> from any other property, seller, or buyer has leaked into your draft.
                            </p>
                          </div>
                          <button onClick={triggerDeedVerificationAudit} className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 mx-auto">
                            <FileCheck2 className="w-4 h-4" /> Run Comprehensive Verification
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* STEP 7: A4 Stamp-Paper Print Preview — paginated, Word-style (matches server .docx) */}
                  {currentStep === 7 && (() => {
                    const pageCount = Math.max(1, deedPages.length);
                    const safeIdx = Math.min(currentPageIdx, pageCount - 1);
                    const isFirst = safeIdx === 0;
                    const pageText = deedPages[safeIdx] ?? filledDeedText;
                    const goPrev = () => setCurrentPageIdx((i) => Math.max(0, i - 1));
                    const goNext = () => setCurrentPageIdx((i) => Math.min(pageCount - 1, i + 1));
                    const scaledW = A4_WIDTH_PX * previewScale;
                    const scaledH = A4_HEIGHT_PX * previewScale;
                    // When a filled .docx is available (and rendered OK), show the REAL
                    // document — all pages, real tables/formatting — instead of the
                    // text-paginated approximation. Editing always uses the text editor.
                    const showRealDocx = !previewEditing && !!generatedDocxBase64 && !docxPreviewError;
                    return (
                    <div className="space-y-4">
                      <div className="p-3.5 bg-[#eef6f5] border border-[#c3dedb] rounded-lg text-[11px] text-[#0a4d4a] flex items-start gap-2.5">
                        <Info className="w-4 h-4 shrink-0 mt-0.5" />
                        {showRealDocx ? (
                          <p>
                            This is the <b>actual Word document</b> that will download — real tables, centered/bold headings, fonts and
                            page breaks preserved from your template, with your Step-1 details filled in. Scroll to see every page. Turn on
                            <b> Edit</b> to change any wording — your edits carry into the download.
                          </p>
                        ) : (
                          <p>
                            Exact A4 preview of the Word document — Times New Roman 14pt, 0.75&quot; side and 1&quot; bottom margins. Only
                            <b> page 1</b> reserves 5.8&quot; at the top for the pre-printed stamp logo &amp; header; every other page uses the
                            normal 1&quot; top margin (no blank space). Flip pages with the arrows. Turn on <b>Edit</b> to change the text —
                            your edits carry into the download.
                          </p>
                        )}
                      </div>

                      {/* Toolbar: page nav + edit toggle */}
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                          {showRealDocx ? (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-[#0a4d4a] bg-[#0a4d4a]/10 border border-[#0a4d4a]/25 px-2.5 py-1.5 rounded flex items-center gap-1.5">
                              <FileCheck2 className="w-3.5 h-3.5" /> Actual Word document — scroll to view all pages
                            </span>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={goPrev}
                                disabled={isFirst}
                                title="Previous page"
                                className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                              >
                                <ChevronLeft className="w-5 h-5" />
                              </button>
                              <div className="text-xs font-bold text-slate-700 tabular-nums select-none min-w-[92px] text-center">
                                Page {safeIdx + 1} <span className="text-slate-400 font-medium">of {pageCount}</span>
                              </div>
                              <button
                                type="button"
                                onClick={goNext}
                                disabled={safeIdx >= pageCount - 1}
                                title="Next page"
                                className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                              >
                                <ChevronRight className="w-5 h-5" />
                              </button>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {!showRealDocx && isFirst && (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-[#b58c4c] bg-[#b58c4c]/10 border border-[#b58c4c]/30 px-2 py-1 rounded flex items-center gap-1">
                              <BookOpen className="w-3.5 h-3.5" /> Stamp reserve on this page
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={togglePreviewEditing}
                            title={previewEditing ? "Finish editing and re-flow pages" : "Edit the full document text"}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider border shadow-sm transition-colors ${
                              previewEditing
                                ? "bg-orange-100 text-orange-700 border-orange-300 hover:bg-orange-200"
                                : "bg-white text-slate-600 border-slate-300 hover:bg-slate-100"
                            }`}
                          >
                            {previewEditing ? (<><Unlock className="w-3.5 h-3.5" /> Editing — click to paginate</>) : (<><Edit2 className="w-3.5 h-3.5" /> Edit text</>)}
                          </button>
                        </div>
                      </div>

                      {/* Hidden measurer: sized to the exact printable width so wrapping matches print. */}
                      <div
                        ref={deedMeasureRef}
                        aria-hidden="true"
                        style={{ position: "absolute", visibility: "hidden", pointerEvents: "none", left: -99999, top: 0, width: `${DEED_CONTENT_WIDTH_PX}px`, ...DEED_TEXT_STYLE }}
                      />

                      {/* Stage. VIEW MODE renders each sheet at FULL native A4 pixel size with
                          real geometry, then scales the whole sheet with a SINGLE transform to
                          fit the panel — nothing double-scales and preview == print. EDIT MODE is
                          a comfortable full-width editor (not scaled, so the text stays readable);
                          pages re-flow when you leave edit mode. */}
                      {showRealDocx ? (
                        // REAL DOCUMENT VIEW: render the actual filled .docx — tables,
                        // centered/bold titles, correct fonts and true page breaks — i.e.
                        // exactly what downloads. Shared with the Auto-Fill Draft (Step 4)
                        // so both previews are identical. Falls back to the text view on
                        // any render error.
                        <DocxLivePreview
                          docxBase64={generatedDocxBase64}
                          onError={() => setDocxPreviewError(true)}
                        />
                      ) : (
                      <div
                        ref={previewWrapRef}
                        className="bg-slate-200/70 rounded-xl p-5 flex justify-center overflow-hidden"
                      >
                        {previewEditing ? (
                          <div className="w-full bg-white shadow-xl rounded-sm p-6">
                            <textarea
                              value={filledDeedText}
                              onChange={(e) => handleDeedTextEdit(e.target.value)}
                              autoFocus
                              spellCheck={false}
                              className="w-full bg-transparent border border-dashed border-slate-300 rounded p-3 outline-none focus:ring-1 focus:ring-[#0a4d4a] resize-y"
                              style={{ ...DEED_TEXT_STYLE, minHeight: "60vh" }}
                            />
                            <p className="mt-2 text-[10px] text-slate-400">
                              Tip: insert a line reading <code className="px-1 bg-slate-100 rounded">---PAGE BREAK---</code> to force a new page. Click <b>Editing — click to paginate</b> above when done.
                            </p>
                          </div>
                        ) : (
                          // TEXT FALLBACK: A4-styled plain-text page (used for library
                          // templates or if the .docx failed to render). Scaled-to-fit
                          // placeholder reserves the exact on-screen space; the single
                          // transform inside does all the scaling.
                          <div style={{ width: `${scaledW}px`, height: `${scaledH}px` }}>
                            <div style={{ transform: `scale(${previewScale})`, transformOrigin: "top left" }}>
                              {/* A single A4 sheet showing ONLY the current page, at native size. */}
                              <div
                                className="bg-white shadow-xl relative overflow-hidden"
                                style={{ width: `${A4_WIDTH_PX}px`, height: `${A4_HEIGHT_PX}px` }}
                              >
                                {/* Page-1-only stamp/header reserve */}
                                {isFirst && (
                                  <div
                                    className="absolute left-0 right-0 top-0 border-b border-dashed border-[#b58c4c]/50 flex flex-col items-center justify-center text-[#b58c4c]/70 pointer-events-none"
                                    style={{ height: `${DEED_STAMP_RESERVE_IN * PX_PER_IN}px` }}
                                  >
                                    <BookOpen className="w-10 h-10 mb-2" />
                                    <p className="text-sm font-bold uppercase tracking-widest">Reserved for Stamp Logo &amp; Header</p>
                                    <p className="text-xs">(top 5.8&quot; of page 1 only)</p>
                                  </div>
                                )}
                                {/* Page body — padded exactly like the .docx; page 1 pushed below the reserve. */}
                                <div
                                  style={{
                                    position: "absolute",
                                    top: `${(isFirst ? DEED_STAMP_RESERVE_IN : DEED_TOP_MARGIN_IN) * PX_PER_IN}px`,
                                    left: `${DEED_SIDE_MARGIN_IN * PX_PER_IN}px`,
                                    width: `${DEED_CONTENT_WIDTH_PX}px`,
                                    bottom: `${DEED_BOTTOM_MARGIN_IN * PX_PER_IN}px`,
                                    overflow: "hidden",
                                    ...DEED_TEXT_STYLE,
                                  }}
                                >
                                  {pageText}
                                </div>
                                {/* Printed page number, bottom-center, like a real deed. */}
                                <div
                                  className="absolute left-0 right-0 flex justify-center text-slate-500 pointer-events-none"
                                  style={{ bottom: `${0.35 * PX_PER_IN}px`, fontFamily: DEED_FONT_FAMILY, fontSize: "11pt" }}
                                >
                                  - {safeIdx + 1} -
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      )}

                      {/* Page dots for quick jumping when there are a handful of pages */}
                      {!showRealDocx && !previewEditing && pageCount > 1 && pageCount <= 20 && (
                        <div className="flex items-center justify-center gap-1.5 flex-wrap">
                          {deedPages.map((_, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setCurrentPageIdx(i)}
                              title={`Go to page ${i + 1}`}
                              className={`h-2.5 rounded-full transition-all ${i === safeIdx ? "w-6 bg-[#0a4d4a]" : "w-2.5 bg-slate-300 hover:bg-slate-400"}`}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                    );
                  })()}

                  {/* STEP 6: Generate Property Plan (Hand-Drawn Sketch -> CAD AI Image) */}
                  {currentStep === 6 && (
                    <div className="space-y-6">
                      {/* Top Header Card */}
                      <div className="p-4 bg-[#eef6f5] border border-[#c3dedb] rounded-xl flex items-start justify-between gap-4 flex-wrap">
                        <div className="flex items-start gap-3">
                          <div className="p-2.5 bg-[#0a4d4a] text-white rounded-lg shadow-xs">
                            <Sparkles className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="font-extrabold text-sm text-slate-900 flex items-center gap-2">
                              <span>Property Plan Generator &amp; Boundary Verifier</span>
                              <span className="text-[10px] text-[#0a4d4a] bg-white px-2 py-0.5 rounded border border-[#c3dedb] font-black uppercase">
                                ప్లాన్ జనరేషన్
                              </span>
                            </h4>
                            <p className="text-xs text-slate-600 mt-1 max-w-xl">
                              Upload a hand-drawn sketch of the plot or house. Gemini AI converts it into a neat, computerized architectural blueprint drawing and cross-checks all boundaries against your Step 1 Registration Form.
                            </p>
                          </div>
                        </div>

                        {sketchImage && (
                          <button
                            onClick={() => handleGeneratePlan()}
                            disabled={planGenerating}
                            className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 text-white font-bold text-xs py-2.5 px-4 rounded-lg flex items-center gap-2 shadow-xs cursor-pointer"
                          >
                            <RefreshCw className={`w-4 h-4 ${planGenerating ? "animate-spin" : ""}`} />
                            {planGenerating ? "Generating CAD Plan..." : "Re-Generate AI Plan"}
                          </button>
                        )}
                      </div>

                      {/* Custom Prompt Box on Top */}
                      <div className="bg-white p-4 border border-slate-200 rounded-xl space-y-3 shadow-2xs">
                        <label className="text-xs font-bold text-slate-800 flex items-center justify-between">
                          <span className="flex items-center gap-1.5">
                            <Edit2 className="w-3.5 h-3.5 text-[#0a4d4a]" /> Custom AI Plan Prompt &amp; Editing Instructions
                          </span>
                          <span className="text-[10px] text-slate-400 font-normal">Optional customization</span>
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={planCustomPrompt}
                            onChange={(e) => setPlanCustomPrompt(e.target.value)}
                            placeholder="e.g. Draw 18' Road in South in blue accent, highlight RCC house in light green, clean CAD font style..."
                            className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0a4d4a]"
                          />
                          <button
                            onClick={() => handleGeneratePlan()}
                            disabled={planGenerating || !sketchImage}
                            className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 text-white font-bold text-xs py-2 px-4 rounded-lg flex items-center gap-1.5 shrink-0 cursor-pointer shadow-3xs"
                          >
                            <Sparkles className="w-3.5 h-3.5" /> Apply Prompt
                          </button>
                        </div>

                        {/* Collapsible Master System Prompt View */}
                        <details className="text-[11px] text-slate-500 pt-1">
                          <summary className="cursor-pointer font-bold text-[#0a4d4a] hover:underline flex items-center gap-1">
                            <Info className="w-3.5 h-3.5" /> View Comprehensive AI Master Architectural Prompt
                          </summary>
                          <div className="mt-2 p-3 bg-slate-900 text-slate-200 rounded-lg font-mono text-[10px] whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                            {planMasterPrompt || "Master prompt will be compiled automatically upon image upload..."}
                          </div>
                        </details>
                      </div>

                      {/* Split View: Left (Hand Sketch Upload) vs Right (Computerized AI CAD Image Preview) */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        
                        {/* LEFT PANEL: Hand Drawn Image Upload & Preview */}
                        <div className="bg-white p-5 border border-slate-200 rounded-xl space-y-4 shadow-2xs">
                          <div className="flex items-center justify-between">
                            <h5 className="font-bold text-xs text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                              <UploadCloud className="w-4 h-4 text-[#0a4d4a]" /> Hand-Drawn Plot Sketch
                            </h5>
                            {sketchImage && (
                              <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-bold border border-emerald-200">
                                Uploaded: {sketchFileName || "sketch.png"}
                              </span>
                            )}
                          </div>

                          {!sketchImage ? (
                            <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center space-y-4 bg-slate-50/50 hover:bg-slate-50 transition-colors">
                              <div className="w-12 h-12 bg-[#0a4d4a]/10 text-[#0a4d4a] rounded-full flex items-center justify-center mx-auto">
                                <UploadCloud className="w-6 h-6" />
                              </div>
                              <div>
                                <p className="text-xs font-bold text-slate-800">Upload Hand-Drawn Plot Sketch</p>
                                <p className="text-[11px] text-slate-400 mt-0.5">Select a photo or scan of a hand-drawn house or land layout</p>
                              </div>
                              <label className="inline-flex items-center gap-2 bg-[#0a4d4a] hover:bg-[#073937] text-white font-bold text-xs py-2.5 px-5 rounded-lg cursor-pointer shadow-xs">
                                <UploadCloud className="w-4 h-4" /> Browse Image
                                <input
                                  type="file"
                                  accept="image/*"
                                  onChange={handleSketchUpload}
                                  className="hidden"
                                />
                              </label>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div className="relative rounded-lg overflow-hidden border border-slate-200 bg-slate-900 max-h-80 flex items-center justify-center p-2">
                                <img
                                  src={sketchImage}
                                  alt="Hand drawn sketch"
                                  className="max-h-72 object-contain rounded"
                                />
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <label className="text-[11px] font-bold text-[#0a4d4a] hover:underline cursor-pointer flex items-center gap-1">
                                  <UploadCloud className="w-3.5 h-3.5" /> Replace Sketch Image
                                  <input
                                    type="file"
                                    accept="image/*"
                                    onChange={handleSketchUpload}
                                    className="hidden"
                                  />
                                </label>
                                <button
                                  onClick={() => {
                                    setSketchImage(null);
                                    setGeneratedPlanImage(null);
                                    setPlanVerificationReport(null);
                                    setExtractedPlan(null);
                                  }}
                                  className="text-[11px] font-bold text-red-600 hover:underline cursor-pointer"
                                >
                                  Clear Image
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* RIGHT PANEL: Computerized AI CAD Image Preview */}
                        <div className="bg-white p-5 border border-slate-200 rounded-xl space-y-4 shadow-2xs">
                          <div className="flex items-center justify-between">
                            <h5 className="font-bold text-xs text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                              <Sparkles className="w-4 h-4 text-[#0a4d4a]" /> Computerized AI Plot Plan
                            </h5>
                            {generatedPlanImage && (
                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={() => setPlanExpanded(true)}
                                  className="text-[10px] font-extrabold text-[#0a4d4a] bg-[#eef6f5] hover:bg-[#c3dedb] px-2.5 py-1 rounded border border-[#c3dedb] flex items-center gap-1 cursor-pointer"
                                >
                                  <Maximize2 className="w-3 h-3" /> Expand &amp; Edit
                                </button>
                                <button
                                  onClick={downloadPlanImage}
                                  className="text-[10px] font-extrabold text-[#0a4d4a] bg-[#eef6f5] hover:bg-[#c3dedb] px-2.5 py-1 rounded border border-[#c3dedb] flex items-center gap-1 cursor-pointer"
                                >
                                  <Download className="w-3 h-3" /> Download JPG
                                </button>
                                <button
                                  onClick={exportEditablePlanDocument}
                                  disabled={exportingEditablePlan}
                                  title="Downloads a SEPARATE .docx where every plan element (text, dimensions, boundary lines, north arrow) is a native, editable Word shape instead of one flat picture. Not yet verified visually in Word/LibreOffice — please check it opens correctly on your machine."
                                  className="text-[10px] font-extrabold text-[#0a4d4a] bg-[#eef6f5] hover:bg-[#c3dedb] px-2.5 py-1 rounded border border-[#c3dedb] flex items-center gap-1 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                                >
                                  {exportingEditablePlan ? (
                                    <RefreshCw className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <FileText className="w-3 h-3" />
                                  )}
                                  Editable Plan (Word)
                                </button>
                              </div>
                            )}
                          </div>

                          {planGenerating ? (
                            <div className="h-80 border border-slate-200 rounded-xl bg-slate-50 flex flex-col items-center justify-center p-6 text-center space-y-3">
                              <RefreshCw className="w-8 h-8 text-[#0a4d4a] animate-spin" />
                              <p className="text-xs font-bold text-slate-800">Converting Hand Sketch into AI Computerized Plan...</p>
                              <p className="text-[11px] text-slate-500 max-w-xs">Reading handwritten measurements, boundaries, and rendering vector CAD lines.</p>
                            </div>
                          ) : generatedPlanImage ? (
                            <div className="space-y-3">
                              <button
                                type="button"
                                onClick={() => setPlanExpanded(true)}
                                title="Click to expand & edit"
                                className="group relative rounded-lg overflow-hidden border border-slate-200 bg-white max-h-80 w-full flex items-center justify-center p-2 shadow-inner cursor-zoom-in"
                              >
                                <img
                                  src={generatedPlanImage}
                                  alt="Computerized AI Plot Plan"
                                  className="max-h-72 object-contain rounded"
                                />
                                <span className="absolute top-2 right-2 bg-[#0a4d4a] text-white rounded-md px-2 py-1 text-[10px] font-bold flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <Maximize2 className="w-3 h-3" /> Expand
                                </span>
                              </button>
                              <p className="text-[10px] text-emerald-800 font-semibold bg-emerald-50 p-2 rounded border border-emerald-200 text-center">
                                Clean vector CAD layout generated successfully. Click the preview to expand and refine it with a prompt.
                              </p>
                            </div>
                          ) : planError ? (
                            <div className="h-80 border border-red-200 rounded-xl bg-red-50 flex flex-col items-center justify-center p-6 text-center space-y-3">
                              <AlertTriangle className="w-9 h-9 text-red-500" />
                              <p className="text-xs font-bold text-red-800 max-w-xs">{planError}</p>
                              {sketchImage && (
                                <button
                                  onClick={() => handleGeneratePlan()}
                                  className="text-[11px] font-extrabold text-white bg-[#0a4d4a] hover:bg-[#0d5f5b] px-3 py-1.5 rounded flex items-center gap-1.5 cursor-pointer"
                                >
                                  <RefreshCw className="w-3.5 h-3.5" /> Retry
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="h-80 border border-dashed border-slate-300 rounded-xl bg-slate-50 flex flex-col items-center justify-center p-6 text-center space-y-2">
                              <FileText className="w-10 h-10 text-slate-300" />
                              <p className="text-xs font-bold text-slate-500">AI Computerized Plan Preview</p>
                              <p className="text-[11px] text-slate-400 max-w-xs">Upload a hand sketch on the left to generate the computerized CAD drawing.</p>
                            </div>
                          )}
                        </div>

                      </div>

                      {/* BOUNDARY VERIFICATION & DISCREPANCY AUDIT CARD */}
                      {planVerificationReport && (
                        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-2xs">
                          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                            <h5 className="font-extrabold text-xs text-slate-900 uppercase tracking-wider flex items-center gap-2">
                              <Search className="w-4 h-4 text-[#0a4d4a]" /> Plan vs Registration Form Boundary Cross-Check
                              <span className="text-[10px] text-[#0a4d4a] bg-[#eef6f5] px-2 py-0.5 rounded border border-[#c3dedb]">
                                సరిహద్దుల పోలిక
                              </span>
                            </h5>
                            <span className={`text-[10px] font-black px-2.5 py-1 rounded-full uppercase ${
                              planVerificationReport.notVerified
                                ? "bg-slate-200 text-slate-700"
                                : planVerificationReport.isMatch
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-amber-100 text-amber-900"
                            }`}>
                              {planVerificationReport.notVerified
                                ? "Not Verified"
                                : planVerificationReport.isMatch
                                  ? "Boundaries Approved"
                                  : "Discrepancy Detected"}
                            </span>
                          </div>

                          {/* Extracted Sketch Summary Grid */}
                          {planVerificationReport.extractedFromSketch && (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 p-3 rounded-lg text-[11px] border border-slate-200">
                              <div>
                                <span className="text-slate-400 block text-[9px] font-bold uppercase">East (తూర్పు):</span>
                                <span className="font-semibold text-slate-800">{planVerificationReport.extractedFromSketch.east || "N/A"}</span>
                              </div>
                              <div>
                                <span className="text-slate-400 block text-[9px] font-bold uppercase">West (పడమర):</span>
                                <span className="font-semibold text-slate-800">{planVerificationReport.extractedFromSketch.west || "N/A"}</span>
                              </div>
                              <div>
                                <span className="text-slate-400 block text-[9px] font-bold uppercase">North (ఉత్తరం):</span>
                                <span className="font-semibold text-slate-800">{planVerificationReport.extractedFromSketch.north || "N/A"}</span>
                              </div>
                              <div>
                                <span className="text-slate-400 block text-[9px] font-bold uppercase">South (దక్షిణం):</span>
                                <span className="font-semibold text-slate-800">{planVerificationReport.extractedFromSketch.south || "N/A"}</span>
                              </div>
                            </div>
                          )}

                          {/* Discrepancies List. An audit that never ran must NOT
                              render as a clean bill of health. */}
                          {planVerificationReport.notVerified ? (
                            <div className="bg-slate-50 border border-slate-300 p-3 rounded-lg text-xs text-slate-700 flex items-center gap-2 font-bold">
                              <AlertTriangle className="w-4 h-4 text-slate-500 shrink-0" />
                              {planVerificationReport.notVerifiedReason ||
                                "The sketch could not be cross-checked automatically. Verify the boundaries manually before registration."}
                            </div>
                          ) : planVerificationReport.discrepancies?.length === 0 ? (
                            <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-lg text-xs text-emerald-800 flex items-center gap-2 font-bold">
                              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                              All boundaries and measurements in the hand sketch match the Step 1 Registration Form!
                            </div>
                          ) : (
                            <div className="space-y-2.5">
                              {planVerificationReport.discrepancies?.map((disc: any, i: number) => (
                                <div key={i} className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs space-y-1">
                                  <div className="flex items-center justify-between font-bold text-red-900 text-[11px]">
                                    <span>{disc.direction} Discrepancy: {disc.description}</span>
                                    <span className="bg-red-200 text-red-800 px-1.5 py-0.5 rounded text-[9px]">{disc.severity}</span>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-[10px] bg-white p-2 rounded border border-red-100">
                                    <div><span className="text-slate-400 block">Registration Form:</span> <span className="font-mono text-emerald-700 font-bold">{disc.formDetail}</span></div>
                                    <div><span className="text-slate-400 block">Hand-Drawn Sketch:</span> <span className="font-mono text-red-600 font-bold">{disc.sketchDetail}</span></div>
                                  </div>
                                  {disc.descriptionTe && (
                                    <p className="text-[11px] text-[#0a4d4a] font-semibold pt-1 border-t border-red-100">
                                      <span className="bg-[#0a4d4a]/10 text-[#0a4d4a] font-bold px-1 rounded text-[9px] mr-1">తెలుగు</span>
                                      {disc.descriptionTe}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── EXPAND & EDIT MODAL: fullscreen plan preview + prompt refine ── */}
                      {planExpanded && generatedPlanImage && (
                        <div
                          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
                          onClick={() => setPlanExpanded(false)}
                        >
                          <div
                            className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {/* Modal header */}
                            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-[#eef6f5]">
                              <h4 className="font-extrabold text-sm text-slate-900 flex items-center gap-2">
                                <Maximize2 className="w-4 h-4 text-[#0a4d4a]" /> Registration Plan — Expand &amp; Edit
                              </h4>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={downloadPlanImage}
                                  className="text-[11px] font-extrabold text-[#0a4d4a] bg-white hover:bg-[#c3dedb] px-3 py-1.5 rounded border border-[#c3dedb] flex items-center gap-1 cursor-pointer"
                                >
                                  <Download className="w-3.5 h-3.5" /> Download JPG
                                </button>
                                <button
                                  onClick={exportEditablePlanDocument}
                                  disabled={exportingEditablePlan}
                                  title="Downloads a SEPARATE .docx where every plan element (text, dimensions, boundary lines, north arrow) is a native, editable Word shape instead of one flat picture. Not yet verified visually in Word/LibreOffice — please check it opens correctly on your machine."
                                  className="text-[11px] font-extrabold text-[#0a4d4a] bg-white hover:bg-[#c3dedb] px-3 py-1.5 rounded border border-[#c3dedb] flex items-center gap-1 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                                >
                                  {exportingEditablePlan ? (
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <FileText className="w-3.5 h-3.5" />
                                  )}
                                  Editable Plan (Word)
                                </button>
                                <button
                                  onClick={() => setPlanExpanded(false)}
                                  className="text-slate-500 hover:text-slate-900 p-1.5 rounded hover:bg-white cursor-pointer"
                                  title="Close"
                                >
                                  <X className="w-5 h-5" />
                                </button>
                              </div>
                            </div>

                            {/* Large scrollable preview */}
                            <div className="flex-1 overflow-auto bg-slate-100 p-4 flex items-start justify-center">
                              {planGenerating ? (
                                <div className="h-96 flex flex-col items-center justify-center gap-3 text-center">
                                  <RefreshCw className="w-8 h-8 text-[#0a4d4a] animate-spin" />
                                  <p className="text-xs font-bold text-slate-700">Applying your changes and re-rendering the plan…</p>
                                </div>
                              ) : (
                                <img
                                  src={generatedPlanImage}
                                  alt="Registration plan (expanded)"
                                  className="max-w-full shadow-lg rounded bg-white"
                                />
                              )}
                            </div>

                            {/* Prompt-refine bar */}
                            <div className="px-5 py-4 border-t border-slate-200 bg-white space-y-2">
                              <label className="text-[11px] font-bold text-slate-800 flex items-center gap-1.5">
                                <Edit2 className="w-3.5 h-3.5 text-[#0a4d4a]" /> Modify the plan with a prompt
                              </label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={planCustomPrompt}
                                  onChange={(e) => setPlanCustomPrompt(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && sketchImage && !planGenerating) handleGeneratePlan();
                                  }}
                                  placeholder="e.g. Move the 18' road to the south edge, widen the RCC block, add a compound wall on the east…"
                                  className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0a4d4a]"
                                />
                                <button
                                  onClick={() => handleGeneratePlan()}
                                  disabled={planGenerating || !sketchImage}
                                  className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 text-white font-bold text-xs py-2 px-4 rounded-lg flex items-center gap-1.5 shrink-0 cursor-pointer shadow-3xs"
                                >
                                  <Sparkles className="w-3.5 h-3.5" /> {planGenerating ? "Applying…" : "Apply & Re-generate"}
                                </button>
                              </div>
                              <p className="text-[10px] text-slate-400">
                                Your instruction is combined with the original hand-drawn sketch, so the plan is re-derived — not drawn from scratch.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* STEP 8: Download (docx + pdf) & Print */}
                  {currentStep === 8 && (
                    <div className="flex flex-col items-center justify-center text-center p-8 space-y-6">
                      <FileText className="w-16 h-16 text-[#0a4d4a]/20 mx-auto" />
                      <div>
                        <h4 className="font-bold text-slate-800">Download &amp; Print Final Deed</h4>
                        <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                          Your deed is formatted to the official Telangana stamp-paper layout. Download an editable Word (.docx) or a PDF,
                          or print it directly with the correct A4 margins.
                        </p>
                      </div>

                      <div className="flex flex-wrap justify-center gap-3">
                        <button
                          onClick={() => exportDocument("docx")}
                          disabled={exporting !== ""}
                          className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 text-white text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 shadow-sm"
                        >
                          <Download className="w-4 h-4" /> {exporting === "docx" ? "Preparing…" : "Download Word (.docx)"}
                        </button>
                        <button
                          onClick={() => exportDocument("pdf")}
                          disabled={exporting !== ""}
                          className="bg-white border border-[#0a4d4a] text-[#0a4d4a] hover:bg-[#eef6f5] disabled:opacity-50 text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 shadow-sm"
                        >
                          <Download className="w-4 h-4" /> {exporting === "pdf" ? "Preparing…" : "Download PDF"}
                        </button>
                        <button
                          onClick={printDeed}
                          className="bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold py-3 px-6 rounded-lg flex items-center gap-1.5 border border-slate-300"
                        >
                          <Printer className="w-4 h-4" /> Print Deed
                        </button>
                      </div>

                      <p className="text-[10px] text-slate-400 max-w-md">
                        The Word file is fully editable for last-mile changes. If the PDF engine is unavailable on the server, the Word file is
                        downloaded instead and you can use <span className="font-semibold">Print → Save as PDF</span>.
                      </p>
                    </div>
                  )}

                </motion.div>
              </AnimatePresence>

            </div>

            {/* WIZARD ACTIONS FOOTER BUTTONS */}
            <div className="border-t border-slate-100 p-4 bg-slate-50 flex items-center justify-between gap-4">
              <button
                onClick={() => setCurrentStep(prev => Math.max(1, prev - 1))}
                disabled={currentStep === 1}
                className="bg-white border border-slate-300 hover:bg-slate-100 disabled:opacity-50 text-slate-700 font-bold text-xs py-2 px-4 rounded-lg flex items-center gap-1.5 shadow-3xs cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" /> Previous Step
              </button>

              {flowMode === "verify" ? (
                currentStep < 3 ? (
                  <button
                    disabled={verifyDocParsing || (currentStep === 2 && !filledDeedText.trim())}
                    onClick={() => {
                      // 3-step verify flow: Registration → Upload → Verify
                      if (currentStep === 1) {
                        setCurrentStep(2); // proceed to Upload Document
                      } else if (currentStep === 2) {
                        if (filledDeedText.trim()) setCurrentStep(3); // proceed to Verify
                      }
                    }}
                    className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs py-2 px-5 rounded-lg flex items-center gap-1.5 shadow-sm cursor-pointer"
                  >
                    {currentStep === 1 && "Proceed to Upload Document"}
                    {currentStep === 2 && (verifyDocParsing ? "Reading…" : filledDeedText.trim() ? "Proceed to Verify" : "Upload a document first")}
                    {" "}<ChevronRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setCurrentStep(1);
                      setReport(null);
                      setFilledDeedText("");
                      setVerifyDocName("");
                      clearAiStatus();
                    }}
                    className="bg-[#14837e] hover:bg-[#106c68] text-white font-bold text-xs py-2 px-5 rounded-lg flex items-center gap-1.5 shadow-sm cursor-pointer"
                  >
                    Reset Verification <RefreshCw className="w-4 h-4 animate-spin-slow" />
                  </button>
                )
              ) : currentStep < 8 ? (
                <button
                  disabled={filling || auditing || (currentStep === 3 && !selectedTemplateId)}
                  onClick={() => {
                    // Step validation or quick triggers for the 8-step flow
                    if (currentStep === 1) {
                      setCurrentStep(2); // proceed to Review Details
                    } else if (currentStep === 2) {
                      setCurrentStep(3); // proceed to Select Template
                    } else if (currentStep === 3) {
                      if (selectedTemplateId) setCurrentStep(4); // proceed to Auto-Fill
                    } else if (currentStep === 4) {
                      if (filledDeedText) setCurrentStep(5);
                      else generateDocument(true);
                    } else if (currentStep === 5) {
                      if (report) setCurrentStep(6);
                      else triggerDeedVerificationAudit();
                    } else if (currentStep === 6) {
                      setCurrentStep(7); // proceed to Stamp Preview
                    } else if (currentStep === 7) {
                      setCurrentStep(8); // proceed to Download & Print
                    }
                  }}
                  className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs py-2 px-5 rounded-lg flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {currentStep === 1 && "Proceed to Review Details"}
                  {currentStep === 2 && "Proceed to Select Template"}
                  {currentStep === 3 && (selectedTemplateId ? "Proceed to Auto-Fill" : "Select a template first")}
                  {currentStep === 4 && (filling ? "Generating…" : filledDeedText ? "Proceed to Re-Verify" : "Generate & Fill Document")}
                  {currentStep === 5 && (auditing ? "Auditing…" : report ? "Proceed to Generate Plan" : "Run Verification Audit")}
                  {currentStep === 6 && "Proceed to Stamp Preview"}
                  {currentStep === 7 && "Proceed to Download & Print"}
                  {" "}<ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  onClick={() => {
                    setCurrentStep(1);
                    setReport(null);
                    setExtractedDetails(null);
                    setGeneratedDocxBase64("");
                    setUnresolvedPlaceholders([]);
                    setFilledDeedText("");
                    setMergeMode("");
                  }}
                  className="bg-[#14837e] hover:bg-[#106c68] text-white font-bold text-xs py-2 px-5 rounded-lg flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  Reset Wizard <RefreshCw className="w-4 h-4 animate-spin-slow" />
                </button>
              )}
            </div>

          </div>

          {/* RIGHT SIDEBAR PANEL - 4 Cols (AI Audit logs & History Register) */}
          {report && (
          <div className="lg:col-span-4 space-y-6">

            {/* AUDIT LOG STATUS BAR */}
            {report && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Search className="w-4 h-4 text-[#0a4d4a]" /> Discrepancy Registry
                  </span>
                  <span className="text-[10px] text-[#0a4d4a] font-black uppercase tracking-widest bg-[#eef6f5] px-2 py-0.5 rounded border border-[#c3dedb]">
                    తేడాల రిజిస్ట్రీ
                  </span>
                </h3>
                
                {report.allDiscrepancies?.length === 0 ? (
                  <div className="bg-emerald-50 border border-emerald-100 p-3.5 rounded-lg text-xs text-emerald-800 flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-extrabold text-[11px] uppercase tracking-wider flex items-center gap-1.5 flex-wrap">
                        <span>Deed is 100% Compliant!</span>
                        <span className="text-emerald-700 font-bold">· దస్తావేజు 100% సరిగ్గా ఉంది!</span>
                      </p>
                      <p className="mt-1 text-slate-600 font-sans leading-relaxed text-[11px]">
                        All spelling digits, age caps, and survey boundaries are approved.
                        <span className="block text-emerald-800 font-semibold mt-0.5">
                          అక్షరక్రమం, వయస్సు పరిమితులు, సర్వే నంబర్లు మరియు సరిహద్దులు అన్నీ సరిగ్గా సరిపోలాయి.
                        </span>
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                    {report.allDiscrepancies?.map((item: any, idx: number) => {
                      const teluguCat = getTeluguCategory(item.category);
                      const teluguDesc = item.descriptionTe || getTeluguDescription(item.description);
                      const teluguRec = item.recommendationTe || getTeluguRecommendation(item.recommendation);
                      return (
                        <div key={idx} className="p-3 bg-red-50/50 border border-red-200 rounded-lg text-[11px] space-y-2 shadow-2xs">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="text-[9px] bg-red-100 text-red-800 font-black px-2 py-0.5 rounded-full uppercase flex items-center gap-1">
                              <span>{item.severity}</span>
                              <span className="text-red-700 font-bold">({item.severity === "CRITICAL" ? "తీవ్రమైనది" : "హెచ్చరిక"})</span>
                            </span>
                            <span className="text-[10px] text-slate-600 font-bold bg-white px-2 py-0.5 rounded border border-slate-200">
                              {item.category} {teluguCat && <span className="text-[#0a4d4a] font-semibold">· {teluguCat}</span>}
                            </span>
                          </div>

                          {/* Description in English and Telugu */}
                          <div className="space-y-1 bg-white p-2.5 rounded-md border border-red-100">
                            <p className="font-bold text-slate-900 leading-snug">{item.description}</p>
                            {teluguDesc && (
                              <p className="text-[11px] text-[#0a4d4a] font-semibold font-sans leading-relaxed border-t border-slate-100 pt-1">
                                <span className="bg-[#0a4d4a]/10 text-[#0a4d4a] font-extrabold px-1 rounded text-[9px] mr-1 uppercase">తెలుగు</span>
                                {teluguDesc}
                              </p>
                            )}
                          </div>

                          {/* Expected vs Found values */}
                          <div className="grid grid-cols-2 gap-2 text-[10px] bg-white p-2 rounded-md border border-slate-200">
                            <div>
                              <span className="text-slate-500 block font-bold uppercase text-[9px]">EXPECTED / ఆశించినది:</span>
                              <span className="text-emerald-700 font-black font-mono text-[11px]">{item.expected}</span>
                            </div>
                            <div>
                              <span className="text-slate-500 block font-bold uppercase text-[9px]">FOUND / కనుగొనబడినది:</span>
                              <span className="text-red-600 font-black font-mono text-[11px]">{item.found}</span>
                            </div>
                          </div>

                          {/* Recommendation in English and Telugu */}
                          <div className="text-[10px] text-slate-700 bg-amber-50/60 p-2 rounded-md border border-amber-200 space-y-1">
                            <p className="leading-relaxed">
                              <strong className="text-amber-900 font-extrabold uppercase text-[9px] mr-1">Recommendation:</strong>
                              <span className="font-medium text-slate-800">{item.recommendation}</span>
                            </p>
                            {teluguRec && (
                              <p className="leading-relaxed text-amber-950 font-semibold font-sans border-t border-amber-200/60 pt-1 text-[10.5px]">
                                <strong className="text-[#0a4d4a] font-extrabold mr-1">తెలుగు సూచన:</strong>
                                {teluguRec}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}


          </div>
          )}

        </div>

      </main>
    </div>
  );
}
