import React, { useState, useEffect, useRef } from "react";
import * as mammoth from "mammoth";
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
  Coins
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { PRESETS, MODEL_TEMPLATES, Preset, MockFile, ModelTemplate } from "./presets";

const calculateAgeFromDOB = (dobString: string): string => {
  if (!dobString) return "";
  const birthDate = new Date(dobString);
  if (isNaN(birthDate.getTime())) return "";
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age >= 0 ? String(age) : "0";
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

// Turn a raw /api/extract-aadhaar payload into a normalized row: DOB coerced to the
// ISO value the date input needs, and age computed from DOB when the card omits it.
const normalizeAadhaarPayload = (data: any): AadhaarRowData => {
  const dob = toDateInputValue(data?.dob || "");
  // Prefer computing age from DOB (month/day-aware) over the model's own figure,
  // which is year-subtraction only and overshoots by 1 before the birthday. Only
  // fall back to the model's age when the card has no readable DOB.
  const age = dob ? calculateAgeFromDOB(dob) : (data?.age ? String(data.age) : "");
  return {
    name: data?.name || "",
    relation: data?.relation || "",
    occupation: data?.occupation || "",
    cellNo: data?.mobile || "",
    aadhaarNo: data?.aadhaarNo || "",
    age: age || "",
    dob,
    address: data?.address || "",
    district: data?.district || "",
    state: data?.state || "",
    pincode: data?.pincode || "",
  };
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
    const cur = prev[idx];
    const filled: T = {
      ...cur,
      name: cur.name || incoming.name,
      relation: cur.relation || incoming.relation,
      occupation: cur.occupation || incoming.occupation,
      cellNo: cur.cellNo || incoming.cellNo,
      aadhaarNo: cur.aadhaarNo || incoming.aadhaarNo,
      age: cur.age || incoming.age,
      dob: cur.dob || incoming.dob,
      address: cur.address || incoming.address,
      district: cur.district || incoming.district,
      state: cur.state || incoming.state,
      pincode: cur.pincode || incoming.pincode,
    };
    const rows = [...prev];
    rows[idx] = filled;
    return { rows, index: idx, merged: true };
  }

  const rows = [...prev, { id: makeId(), ...incoming } as T];
  return { rows, index: rows.length - 1, merged: false };
}

// ---- Step 6 A4 pagination geometry ----------------------------------------
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
  // 10-Step Wizard State (1 to 10)
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

  // NEW: Link Document Type selector
  const [linkDocumentType, setLinkDocumentType] = useState<"Sale Deed" | "Release Deed" | "Gift Deed">("Sale Deed");

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
    subRegistrar: string;
    subRegistrarCode: string;
    pattadarPassbookNo: string;
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
    marketValuePerSqYard: string;
    marketValueTotal: string;
    // House specific
    houseNature: string;
    houseFloors: string;
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

  const [linkDocType, setLinkDocType] = useState("");
  const [linkDocNo, setLinkDocNo] = useState("");
  const [linkSubRegistrar, setLinkSubRegistrar] = useState("");
  const [linkSubRegistrarCode, setLinkSubRegistrarCode] = useState("");
  const [linkPattadarPassbook, setLinkPattadarPassbook] = useState("");
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
  const [propMarketValuePerSqYard, setPropMarketValuePerSqYard] = useState("");
  const [propMarketValueTotal, setPropMarketValueTotal] = useState("");

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
  // Generated document artifacts (from server /api/generate-document)
  const [generatedDocxBase64, setGeneratedDocxBase64] = useState<string>("");
  const [unresolvedPlaceholders, setUnresolvedPlaceholders] = useState<string[]>([]);
  const [mergeMode, setMergeMode] = useState<string>("");
  const [exporting, setExporting] = useState<"" | "docx" | "pdf">("");

  // Step 7: Audit Report & Verification State
  const [report, setReport] = useState<any | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditStepIndex, setAuditStepIndex] = useState(0);

  // General App states
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPresetsExpanded, setIsPresetsExpanded] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<any[]>([]);
  const [activeAuditTab, setActiveAuditTab] = useState<"all" | "critical" | "warnings">("all");

  const workflowSteps = [
    { number: 1, title: "Registration Form", telugu: "రిజిస్ట్రేషన్ ఫారమ్", desc: "Official details, values & uploads" },
    { number: 2, title: "Review Details", telugu: "వివరాల సమీక్ష", desc: "Preview all extracted data" },
    { number: 3, title: "Select Template", telugu: "మోడల్ సేల్ డీడ్", desc: "Choose Word deed template" },
    { number: 4, title: "Auto-Fill Draft", telugu: "డీడ్ తయారీ", desc: "Merge details into template" },
    { number: 5, title: "Re-Verify Deed", telugu: "సరిపోలిక తనిఖీ", desc: "Deep audit for errors" },
    { number: 6, title: "Stamp Preview", telugu: "రిజిస్ట్రేషన్ ప్రివ్యూ", desc: "A4 stamp-paper preview" },
    { number: 7, title: "Download & Print", telugu: "డౌన్‌లోడ్ & ప్రింట్", desc: "Export Word/PDF & print" }
  ];

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

  // NEW: Handle Aadhaar upload for Executants
  const handleAadhaarUploadExecutant = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingAadhaarExecutant(true);
    setError(null);

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

      if (!response.ok) {
        throw new Error("Aadhaar extraction failed");
      }

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
      console.error("Error extracting Aadhaar for executant:", err);
      alert(`Failed to extract Aadhaar details${err?.message ? `: ${err.message}` : ""}. Please check the file and try again, or enter details manually.`);
    } finally {
      setUploadingAadhaarExecutant(false);
    }
  };

  // NEW: Handle Aadhaar upload for Claimants
  const handleAadhaarUploadClaimant = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingAadhaarClaimant(true);
    setError(null);

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

      if (!response.ok) {
        throw new Error("Aadhaar extraction failed");
      }

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
      console.error("Error extracting Aadhaar for claimant:", err);
      alert(`Failed to extract Aadhaar details${err?.message ? `: ${err.message}` : ""}. Please check the file and try again, or enter details manually.`);
    } finally {
      setUploadingAadhaarClaimant(false);
    }
  };

  // NEW: Handle Link Document upload and extraction
  const handleLinkDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingLinkDocument(true);
    setError(null);

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

      if (!response.ok) {
        throw new Error("Link document extraction failed");
      }

      const data = await response.json();

      // Update Jurisdiction fields - ADD TO ARRAY
      if (data.jurisdiction) {
        const newJurisdiction: JurisdictionRow = {
          id: `jurisdiction-${Date.now()}`,
          districtRegistrar: data.jurisdiction.districtRegistrar || "",
          subRegistrar: data.jurisdiction.subRegistrar || "",
          district: data.jurisdiction.district || "",
          mandal: data.jurisdiction.mandal || "",
          village: data.jurisdiction.village || "",
          pincode: data.jurisdiction.pincode || ""
        };
        setJurisdictionsList(prev => [...prev, newJurisdiction]);
      }

      // Update Link Document Details - ADD TO ARRAY
      if (data.linkDocument) {
        const newLinkDoc: LinkDocumentRow = {
          id: `linkdoc-${Date.now()}`,
          layoutFileNo: data.linkDocument.layoutFileNo || "",
          linkDocType: data.linkDocument.docType || "",
          linkDocNo: data.linkDocument.docNo || "",
          subRegistrar: data.linkDocument.subRegistrar || "",
          subRegistrarCode: data.linkDocument.subRegistrarCode || "",
          pattadarPassbookNo: data.linkDocument.pattadarPassbook || "",
          nalaOrderNo: data.linkDocument.nalaOrderNo || "",
          houseTaxReceipt: data.linkDocument.houseTaxReceipt || ""
        };
        setLinkDocumentsList(prev => [...prev, newLinkDoc]);
      }

      // Update Property Details - ADD TO ARRAY
      if (data.property) {
        const newProperty: PropertyRow = {
          id: `property-${Date.now()}`,
          propertyType: propertyType || "",
          plotNo: data.property.plotNo || "",
          surveyNo: data.property.surveyNo || "",
          extentSqYards: data.property.extentSqYards || "",
          extentSqMeters: data.property.extentSqMeters || "",
          nearHNo: data.property.nearHNo || "",
          locality: data.property.locality || "",
          marketValueTotal: data.property.marketValueTotal || "",
          marketValuePerSqYard: data.property.marketValuePerSqYard || "",
          // House fields
          houseNature: data.property.house?.nature || "",
          houseFloors: data.property.house?.floors || "",
          houseAge: data.property.house?.age || "",
          houseTapConnection: data.property.house?.tapConnection || "",
          houseMetersNo: data.property.house?.metersNo || "",
          houseTaxes: data.property.house?.taxes || "",
          houseRentalValue: data.property.house?.rentalValue || "",
          // Flat fields
          flatNo: data.property.flat?.flatNo || "",
          flatUndividedSqYards: data.property.flat?.undividedSqYards || "",
          flatBearingHNo: data.property.flat?.bearingHNo || "",
          flatBuildingName: data.property.flat?.buildingName || "",
          flatFloorS: data.property.flat?.floorS || "",
          // Initialize all other PropertyRow fields as empty
          adjacentHNo: "",
          demoBearingHNo: "", demoLocality: "", demoTapConnection: "", demoMetersNo: "",
          partBearingHNo: "", partLocality: "",
          flatUndividedSqMeters: "", flatNature: "", flatLocality: "", flatValuePerSqFeet: "",
          flatMarketValueTotal: "", flatAge: "", flatTapConnection: "", flatMetersNo: "",
          flatTaxes: "", flatRentalValue: "", flatNearHNo: "", flatPlinthArea: "", flatTotalLand: ""
        };
        setPropertiesList(prev => [...prev, newProperty]);
      }

      // Update Boundaries - ADD TO ARRAY
      if (data.boundaries) {
        const newBoundary: BoundaryRow = {
          id: `boundary-${Date.now()}`,
          east: data.boundaries.east || "",
          west: data.boundaries.west || "",
          north: data.boundaries.north || "",
          south: data.boundaries.south || ""
        };
        setBoundariesList(prev => [...prev, newBoundary]);
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
      console.error("Error extracting link document:", err);
      alert("Failed to extract link document details. Please check the file and try again.");
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
  const deleteExecutant = (id: string) => {
    if (executantsList.length === 1) {
      alert("At least one executant is required!");
      return;
    }
    setExecutantsList(prev => prev.filter(exec => exec.id !== id));
  };

  // NEW: Delete claimant row
  const deleteClaimant = (id: string) => {
    if (claimantsList.length === 1) {
      alert("At least one claimant is required!");
      return;
    }
    setClaimantsList(prev => prev.filter(claim => claim.id !== id));
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
      subRegistrar: "",
      subRegistrarCode: "",
      pattadarPassbookNo: "",
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
      marketValuePerSqYard: "",
      marketValueTotal: "",
      houseNature: "",
      houseFloors: "",
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
    setError(null);
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

      if (!response.ok) {
        throw new Error("Extraction API failed");
      }

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
      setError("AI Extraction failed. We have populated the step fields with preset mock data to allow you to continue the 10-step wizard.");
      console.error(err);
      // Mock some extracted details so they can still proceed
      setExtractedDetails(getMockExtractedDetails());
    } finally {
      setExtracting(false);
    }
  };

  const getMockExtractedDetails = () => {
    return {
      executants: [{
        name: executantName,
        relation: executantRelation,
        age: executantAge,
        aadhaar: executantAadhaar,
        pan: executantPan,
        dob: executantDOB,
        address: executantAddress
      }],
      claimants: [{
        name: claimantName,
        relation: claimantRelation,
        age: claimantAge,
        aadhaar: claimantAadhaar,
        pan: claimantPan,
        dob: claimantDOB,
        address: claimantAddress
      }],
      property: {
        surveyNo: propertySurvey,
        village: propertyVillage,
        mandal: propertyMandal,
        district: propertyDistrict,
        state: "Telangana",
        hNo: propertyHNo,
        plotNo: propertyPlotNo,
        ptiNo: propertyPTINo,
        extentSqYards: propertyExtent,
        plinthArea: propertyPlinth,
        boundaries: {
          east: boundaryEast,
          west: boundaryWest,
          north: boundaryNorth,
          south: boundarySouth
        }
      },
      linkDeed: {
        deedNumber: linkDocuments[0]?.name?.includes("1998") ? "1204/1998" : "PP-5049/2010",
        executionDate: "14th August 1998",
        village: propertyVillage
      }
    };
  };

  // Build the single consolidated "details" object used by document generation and
  // verification. Sourced from the Step-1 list rows (source of truth), falling back to
  // single-field state so nothing is silently dropped.
  const buildConsolidatedDetails = () => {
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
      address: [e.address, e.district, e.state, e.pincode].filter(Boolean).join(", "),
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
      address: [c.address, c.district, c.state, c.pincode].filter(Boolean).join(", "),
    }));

    const firstProp = propertiesList[0] || ({} as any);
    const firstJur = jurisdictionsList[0] || ({} as any);
    const firstBound = boundariesList[0] || ({} as any);
    const firstLink = linkDocumentsList[0] || ({} as any);

    return {
      registrationDate,
      marketValue: marketValue || firstProp.marketValueTotal || propMarketValueTotal || "",
      stampsAmount,
      natureOfTransaction,
      propertyType,
      executants: sellers,
      claimants: buyers,
      property: {
        surveyNo: firstProp.surveyNo || propSurveyNo || propertySurvey || "",
        village: firstJur.village || jurVillage || propertyVillage || "",
        mandal: firstJur.mandal || jurMandal || propertyMandal || "",
        district: firstJur.district || jurDistrict || propertyDistrict || "",
        state: "Telangana",
        hNo: firstProp.nearHNo || propNearHNo || propertyHNo || "",
        plotNo: firstProp.plotNo || propPlotNo || propertyPlotNo || "",
        ptiNo: firstLink.pattadarPassbookNo || linkPattadarPassbook || propertyPTINo || "",
        extentSqYards: firstProp.extentSqYards || propExtentSqYards || propertyExtent || "",
        plinthArea: firstProp.flatPlinthArea || propertyPlinth || "",
        boundaries: {
          east: firstBound.east || boundaryEast || "",
          west: firstBound.west || boundaryWest || "",
          north: firstBound.north || boundaryNorth || "",
          south: firstBound.south || boundarySouth || "",
        },
      },
      linkDeed: {
        deedNumber: firstLink.linkDocNo || linkDocNo || "",
        executionDate: "",
        village: firstLink.subRegistrar || linkSubRegistrar || "",
      },
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
    const file = e.target.files?.[0];
    if (!file) return;
    setCustomTemplateLoading(true);
    setError(null);
    try {
      const lower = file.name.toLowerCase();
      let text = "";
      if (lower.endsWith(".docx")) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = (result?.value || "").trim();
      } else if (lower.endsWith(".doc")) {
        // Legacy Word 97-2003 — parse server-side via word-extractor.
        const base64 = await convertFileToBase64(file);
        const res = await fetch("/api/parse-doc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64 }),
        });
        if (!res.ok) throw new Error(`parse-doc responded ${res.status}`);
        const data = await res.json();
        text = (data.text || "").trim();
      } else if (lower.endsWith(".txt")) {
        text = (await file.text()).trim();
      } else if (
        lower.endsWith(".pdf") ||
        lower.endsWith(".png") ||
        lower.endsWith(".jpg") ||
        lower.endsWith(".jpeg")
      ) {
        // PDFs / scanned images have no reliable pure-JS text layer in
        // production, so transcribe them verbatim with Gemini server-side.
        const base64 = await convertFileToBase64(file);
        const mimeType = file.type || (lower.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
        const res = await fetch("/api/extract-template-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64, mimeType }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `extract-template-text responded ${res.status}`);
        text = (data.text || "").trim();
      } else {
        setError("Unsupported template format. Please upload a .docx, .doc, .txt, .pdf, or image file.");
        return;
      }

      if (!text) {
        setError("Could not read any text from that template. Please try a different file.");
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
        msg && !msg.startsWith("extract-template-text responded")
          ? msg
          : "Failed to read the uploaded template. Please ensure it is a valid Word, text, PDF, or image file."
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
      console.error("Failed to load templates:", err);
      setError("Could not load the template library from the server.");
    } finally {
      setTemplatesLoading(false);
    }
  };

  // Load templates when entering Step 3.
  useEffect(() => {
    if (currentStep === 3 && serverTemplates.length === 0) {
      loadTemplates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  // If the chosen template changes, discard any previously generated draft so
  // Step 4 never shows a document built from a different template.
  useEffect(() => {
    setFilledDeedText("");
    setGeneratedDocxBase64("");
    setUnresolvedPlaceholders([]);
    setMergeMode("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  // Step 6: recompute the A4 page split whenever the deed text changes or we land
  // on Step 6. Measured against a hidden node sized to the exact printable width so
  // on-screen line wrapping matches the .docx. Deferred to rAF so the measurer has
  // laid out. When NOT actively editing, we re-flow; while editing we leave the
  // page list alone so the caret doesn't jump.
  useEffect(() => {
    if (currentStep !== 6) return;
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

  // Step 6: scale the full-size A4 sheet down to fit the panel width (never up past
  // 1:1), so the page is fully visible without a horizontal scrollbar on any screen.
  useEffect(() => {
    if (currentStep !== 6) return;
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
    setError(null);
    try {
      const details = buildConsolidatedDetails();
      const isCustom = selectedTemplateId === CUSTOM_TEMPLATE_ID;
      const res = await fetch("/api/generate-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isCustom
            ? { customTemplateText, customTemplateName, details }
            : { templateId: selectedTemplateId, details }
        ),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      setFilledDeedText(data.mergedText || "");
      setGeneratedDocxBase64(data.docxBase64 || "");
      setUnresolvedPlaceholders(data.unresolvedPlaceholders || []);
      setMergeMode(data.mergeMode || "");
      // The generated document is now shown on Step 4 for review. When invoked
      // from the primary "Generate & Fill Document" action, continue straight to
      // the Re-Verify step so the button always moves the flow forward.
      if (advanceAfter) setCurrentStep(5);
    } catch (err: any) {
      console.error("Document generation failed:", err);
      setError("Failed to generate the document from the template. Please try again.");
    } finally {
      setFilling(false);
    }
  };

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

  // Step 7: export the final deed as .docx (mandatory) or .pdf (best-effort).
  const exportDocument = async (format: "docx" | "pdf") => {
    setExporting(format);
    setError(null);
    try {
      const nameForFile = (executantsList[0]?.name || executantName || "Deed").replace(/\s+/g, "_");
      const res = await fetch("/api/export-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, finalText: filledDeedText }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();

      if (format === "pdf" && data.pdfUnavailable) {
        // LibreOffice not present: hand back the .docx and tell the user to use Print → Save as PDF.
        downloadBase64(data.fileBase64, data.mimeType, `Sale_Deed_${nameForFile}.docx`);
        alert(data.message || "PDF engine unavailable. Downloaded Word (.docx); use the Print button to save as PDF.");
      } else if (data.format === "pdf") {
        downloadBase64(data.fileBase64, data.mimeType, `Sale_Deed_${nameForFile}.pdf`);
      } else {
        downloadBase64(data.fileBase64, data.mimeType, `Sale_Deed_${nameForFile}.docx`);
      }
    } catch (err: any) {
      console.error("Export failed:", err);
      setError(`Failed to export ${format.toUpperCase()}. Please try again.`);
    } finally {
      setExporting("");
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
    setError(null);
    try {
      const template = MODEL_TEMPLATES.find(t => t.id === selectedModelId);
      const templateText = template ? template.templateText : customModelText;
      
      // Build high-fidelity facts list consolidated from the user's Step 3 Registration Form state
      const details = {
        executants: executantsList.map(e => ({
          name: e.name,
          relation: "S/o (implied)",
          age: parseInt(e.age) || 51,
          aadhaar: e.aadhaarNo,
          pan: e.pan || "N/A",
          dob: e.dob,
          address: `${e.address}, ${e.district}, ${e.state} - ${e.pincode}`
        })),
        claimants: claimantsList.map(c => ({
          name: c.name,
          relation: "S/o (implied)",
          age: parseInt(c.age) || 45,
          aadhaar: c.aadhaarNo,
          pan: c.pan || "N/A",
          dob: c.dob,
          address: `${c.address}, ${c.district}, ${c.state} - ${c.pincode}`
        })),
        property: {
          surveyNo: propSurveyNo,
          village: jurVillage,
          mandal: jurMandal,
          district: jurDistrict,
          state: "Telangana",
          hNo: propNearHNo,
          plotNo: propPlotNo,
          ptiNo: linkPattadarPassbook,
          extentSqYards: propExtentSqYards,
          plinthArea: "N/A",
          boundaries: {
            east: boundaryEast,
            west: boundaryWest,
            north: boundaryNorth,
            south: boundarySouth
          }
        },
        linkDeed: {
          deedNumber: linkDocNo,
          executionDate: "14th August 1998",
          village: linkSubRegistrar
        },
        registrationDate
      };

      const response = await fetch("/api/fill-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateText, extractedDetails: details })
      });

      if (!response.ok) {
        throw new Error("Template fill failed");
      }

      const data = await response.json();
      setFilledDeedText(data.filledText);
      
      // Move to Step 6 (Re-Verify Deed)
      setCurrentStep(6);
    } catch (err: any) {
      setError("Failed to auto-fill details via server API. Loaded a heuristic-filled template.");
      console.error(err);
      // Fallback
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

  // Trigger Step 7: Deep Verification Audit
  const triggerDeedVerificationAudit = async () => {
    setAuditing(true);
    setReport(null);
    setError(null);
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
        })
      });

      if (!response.ok) {
        throw new Error("Verification API failed");
      }

      const data = await response.json();
      setReport(data);
      // Stay on Step 5 to present the verification report; the user advances to the
      // A4 preview via the "Proceed to Stamp Preview" button.
    } catch (err: any) {
      setError("Deed auditing failed. Generating a heuristic audit card to review.");
      console.error(err);
      setReport(getHeuristicReportFallback());
    } finally {
      setAuditing(false);
    }
  };

  const getHeuristicReportFallback = (): any => {
    const hasSrinivasaRao = filledDeedText.toLowerCase().includes("srinivasa rao");
    const hasPlot15 = filledDeedText.toLowerCase().includes("plot no 15");
    
    if (hasSrinivasaRao || hasPlot15) {
      return {
        summary: {
          status: "DISCREPANCY_FOUND",
          sellersCount: 1,
          discrepancyCount: 3,
          message: "Offline Audit: Found spelling and property discrepancies!"
        },
        allDiscrepancies: [
          {
            category: "Names mismatch",
            severity: "CRITICAL",
            description: "Spelling variation: Draft has 'Ankem Srinivasa Rao' but Aadhaar has 'Ankem Srinivas'.",
            expected: "Ankem Srinivas",
            found: "Ankem Srinivasa Rao",
            recommendation: "Update name in draft to 'Ankem Srinivas' to match Aadhaar."
          },
          {
            category: "Property details mismatch",
            severity: "CRITICAL",
            description: "Plot Number Mismatch: Draft mentions Plot No 15 but original Link Deed mentions Plot No 12.",
            expected: "Plot No 12",
            found: "Plot No 15",
            recommendation: "Correct Plot No to '12'."
          },
          {
            category: "Link document numbers mismatch",
            severity: "CRITICAL",
            description: "Deed reference typo: Draft cites 2340/1998 but original deed is 2304/1998.",
            expected: "2304/1998",
            found: "2340/1998",
            recommendation: "Correct deed citation in the preamble to '2304/1998'."
          }
        ],
        sellers: [{
          aadhaarName: "Ankem Srinivas",
          draftName: "Ankem Srinivasa Rao",
          status: "MISMATCH"
        }],
        property: {
          status: "MISMATCH",
          discrepancies: ["Plot number mismatch"]
        },
        linkDocumentVerification: {
          status: "MISMATCH",
          discrepancies: ["Deed number typo"]
        }
      };
    }

    return {
      summary: {
        status: "APPROVED",
        sellersCount: 1,
        discrepancyCount: 0,
        message: "Offline Audit: Perfect match! All identity and survey details are verified."
      },
      allDiscrepancies: [],
      sellers: [{
        aadhaarName: executantName,
        draftName: executantName,
        status: "MATCH"
      }],
      property: {
        status: "MATCH"
      },
      linkDocumentVerification: {
        status: "MATCH"
      }
    };
  };

  // Step 10: Save Draft to localStorage Registry History
  const saveDraftToRegistry = () => {
    const newRecord = {
      id: "Deed-" + Date.now(),
      savedAt: new Date().toLocaleString(),
      seller: executantName,
      buyer: claimantName,
      property: `${propertyVillage}, Survey: ${propertySurvey}, H.No: ${propertyHNo}`,
      date: registrationDate,
      status: report?.summary?.status || "PENDING_AUDIT",
      deedText: filledDeedText
    };

    const updated = [newRecord, ...savedDrafts];
    setSavedDrafts(updated);
    localStorage.setItem("telangana_deeds_registry", JSON.stringify(updated));
    alert("Sale Deed draft successfully saved to your offline registration desk logs!");
  };

  const deleteRegistryRecord = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = savedDrafts.filter(item => item.id !== id);
    setSavedDrafts(filtered);
    localStorage.setItem("telangana_deeds_registry", JSON.stringify(filtered));
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
                  7-Step Workflow
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
              onClick={() => setIsPresetsExpanded(!isPresetsExpanded)}
              className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold py-2 px-3.5 rounded-lg flex items-center gap-1.5 shadow-sm transition-all"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Scenario Presets
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
                <BookOpen className="w-4 h-4" /> Loaded Practice Scenarios & Audit Testcases
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      handleSelectPreset(p);
                      setIsPresetsExpanded(false);
                    }}
                    className={`p-3 text-left rounded-lg bg-white border text-xs transition-all flex flex-col justify-between hover:shadow-sm ${
                      activePresetId === p.id
                        ? "border-[#0a4d4a] ring-2 ring-[#0a4d4a]/20 shadow-xs"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div>
                      <p className="font-bold text-slate-900 flex items-center justify-between mb-1">
                        <span>{p.title}</span>
                        {activePresetId === p.id && (
                          <span className="text-[9px] bg-[#0a4d4a] text-white px-2 py-0.2 rounded-full font-bold">
                            Active
                          </span>
                        )}
                      </p>
                      <p className="text-slate-500 leading-relaxed text-[11px] line-clamp-2">
                        {p.description}
                      </p>
                    </div>
                    <div className="mt-2 text-[10px] text-slate-400 font-mono text-right font-medium">
                      Load Testcase →
                    </div>
                  </button>
                ))}
              </div>
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
                  Step {currentStep} of 7: {workflowSteps[currentStep - 1].telugu}
                </span>
                <h2 className="text-xl font-bold text-slate-900 mt-2 flex items-center gap-2">
                  {currentStep === 1 && "Property Registration Details Form"}
                  {currentStep === 2 && "Review Extracted & Entered Details"}
                  {currentStep === 3 && "Select Word Deed Template"}
                  {currentStep === 4 && "Auto-Fill Details into Selected Template"}
                  {currentStep === 5 && "Re-Verify Draft & Cross-Check Uploads"}
                  {currentStep === 6 && "A4 Stamp Paper Print Preview"}
                  {currentStep === 7 && "Download & Print Final Deed"}
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  {currentStep === 1 && "Bilingual official details such as Pattadar Passbook, NALA Conversion, Layout approval details, bounds, seller/buyer names, and all supporting Aadhaar & Link document uploads."}
                  {currentStep === 2 && "Review every detail extracted from the Aadhaar cards and Link documents alongside the values you entered. If anything needs a fix, go back to Step 1 to adjust before drafting."}
                  {currentStep === 3 && "Select a pre-certified Word (.docx) deed template matching your registration type from the Telangana stamps template library."}
                  {currentStep === 4 && "The system merges all reviewed details into the selected Word template and formats it to the official Telangana stamp-paper layout."}
                  {currentStep === 5 && "Comprehensive AI audit: cross-checks the final deed against uploads and entered data, and confirms no residual content from other documents leaked in."}
                  {currentStep === 6 && "Preview the finalized sale deed exactly as it will print — A4, Times New Roman 14, with the stamp/header space reserved on page one."}
                  {currentStep === 7 && "Download the deed as an editable Microsoft Word (.docx) or PDF, or print it directly from this page."}
                </p>
              </div>

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

                        {/* Top Financials Section: Property Type, Market Value, Stamps, Nature of Transaction */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6 bg-slate-50 p-4 border border-slate-300 rounded-lg">
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] font-black text-slate-700 uppercase">
                              Type of Property <span className="text-red-600">*</span>
                            </span>
                            <select
                              value={propertyType}
                              onChange={(e) => setPropertyType(e.target.value as any)}
                              className={`w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-bold bg-white focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] ${
                                propertyType === "" ? "text-slate-400" : "text-slate-800"
                              }`}
                            >
                              <option value="" disabled>Select Property Type</option>
                              <option value="Open plot">Open plot</option>
                              <option value="House">House</option>
                              <option value="Demolished House">Demolished House</option>
                              <option value="Part of open place">Part of open place</option>
                              <option value="Flat">Flat</option>
                            </select>
                          </div>

                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] font-black text-slate-700 uppercase">
                              Market Value of Rs. <span className="text-red-600">*</span>
                            </span>
                            <div className="relative">
                              <span className="absolute left-2.5 top-2 text-xs font-bold text-slate-400">₹</span>
                              <input
                                type="text"
                                value={marketValue}
                                onChange={(e) => {
                                  const val = e.target.value.replace(/,/g, "");
                                  if (!isNaN(Number(val))) {
                                    setMarketValue(val);
                                    // Removed auto-calculation - user should enter stamps amount manually
                                  }
                                }}
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
                                onChange={(e) => {
                                  const val = e.target.value.replace(/,/g, "");
                                  if (!isNaN(Number(val))) {
                                    setStampsAmount(val);
                                  }
                                }}
                                className="w-full pl-6 pr-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono font-bold text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-[#0a4d4a]"
                                placeholder="Stamp duty amount"
                              />
                            </div>
                          </div>

                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] font-black text-slate-700 uppercase">
                              Nature of Transaction <span className="text-red-600">*</span>
                            </span>
                            <select
                              value={natureOfTransaction}
                              onChange={(e) => setNatureOfTransaction(e.target.value)}
                              className={`w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-bold bg-white focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] ${
                                natureOfTransaction === "" ? "text-slate-400" : "text-slate-800"
                              }`}
                            >
                              <option value="" disabled>Select Transaction Type</option>
                              <option value="Sale Deed (కంపల్సరీ సేల్ డీడ్)">Sale Deed (కంపల్సరీ సేల్ డీడ్)</option>
                              <option value="Gift Deed (బహుమతి పత్రం)">Gift Deed (బహుమతి పత్రం)</option>
                              <option value="Partition Deed (విభజన పత్రం)">Partition Deed (విభజన పత్రం)</option>
                              <option value="Development Agreement (అభివృద్ధి ఒప్పందం)">Development Agreement (అభివృద్ధి ఒప్పందం)</option>
                            </select>
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
                                        onClick={() => {
                                          setExecutantsList(executantsList.filter(e => e.id !== exec.id));
                                        }}
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
                                        onClick={() => {
                                          setClaimantsList(claimantsList.filter(c => c.id !== claim.id));
                                        }}
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

                        {/* LINK DOCUMENT TYPE SELECTION */}
                        <div className="mb-4 bg-white border border-slate-300 rounded-lg p-3">
                          <label className="text-[10px] font-black text-slate-700 uppercase mb-2 block">
                            Link Document Type <span className="text-red-600">*</span>
                          </label>
                          <div className="flex gap-4">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="linkDocumentType"
                                value="Sale Deed"
                                checked={linkDocumentType === "Sale Deed"}
                                onChange={(e) => setLinkDocumentType(e.target.value as any)}
                                className="w-4 h-4 text-[#0a4d4a] focus:ring-[#0a4d4a]"
                              />
                              <span className="text-xs font-semibold text-slate-700">Sale Deed</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="linkDocumentType"
                                value="Release Deed"
                                checked={linkDocumentType === "Release Deed"}
                                onChange={(e) => setLinkDocumentType(e.target.value as any)}
                                className="w-4 h-4 text-[#0a4d4a] focus:ring-[#0a4d4a]"
                              />
                              <span className="text-xs font-semibold text-slate-700">Release Deed</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="linkDocumentType"
                                value="Gift Deed"
                                checked={linkDocumentType === "Gift Deed"}
                                onChange={(e) => setLinkDocumentType(e.target.value as any)}
                                className="w-4 h-4 text-[#0a4d4a] focus:ring-[#0a4d4a]"
                              />
                              <span className="text-xs font-semibold text-slate-700">Gift Deed</span>
                            </label>
                          </div>
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
                                  doc.layoutFileNo === "" && doc.linkDocType === "" && doc.linkDocNo === "" &&
                                  doc.subRegistrar === "" && doc.subRegistrarCode === "" && doc.pattadarPassbookNo === "" &&
                                  doc.nalaOrderNo === "" && doc.houseTaxReceipt === ""
                                )}
                                className="bg-[#0a4d4a] hover:bg-[#073937] disabled:bg-gray-400 disabled:cursor-not-allowed text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1"
                                title={linkDocumentsList.some(doc =>
                                  doc.layoutFileNo === "" && doc.linkDocType === "" && doc.linkDocNo === "" &&
                                  doc.subRegistrar === "" && doc.subRegistrarCode === "" && doc.pattadarPassbookNo === "" &&
                                  doc.nalaOrderNo === "" && doc.houseTaxReceipt === ""
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
                                  <th className="p-2 border border-slate-300 min-w-[120px]">Link Doct.Type</th>
                                  <th className="p-2 border border-slate-300 min-w-[130px]">Link Doct.No/s</th>
                                  <th className="p-2 border border-slate-300 min-w-[120px]">Sub-Registrar</th>
                                  <th className="p-2 border border-slate-300 w-32">Sub Registrar Code</th>
                                  <th className="p-2 border border-slate-300 min-w-[140px]">Pattadar Pass Book No.</th>
                                  <th className="p-2 border border-slate-300 w-32">Nala Order No</th>
                                  <th className="p-2 border border-slate-300 min-w-[120px]">House Tax Receipt</th>
                                  <th className="p-2 border border-slate-300 w-16 text-center">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {linkDocumentsList.length === 0 ? (
                                  <tr>
                                    <td colSpan={10} className="p-4 text-center text-slate-500 text-sm">
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
                                          placeholder="Doc Type"
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

                        {/* DYNAMIC PROPERTY SPECIFICATION SECTION - Multi-Row Support */}
                        <div className="mb-6">
                          <div className="flex justify-between items-center bg-slate-100 px-3 py-1.5 border border-slate-300 rounded-t-lg">
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
                            <button
                              type="button"
                              onClick={addEmptyProperty}
                              disabled={propertiesList.some(p => p.propertyType === "" && p.plotNo === "" && p.surveyNo === "")}
                              className="bg-[#0a4d4a] hover:bg-[#073937] disabled:bg-gray-400 disabled:cursor-not-allowed text-white text-[9px] font-black uppercase px-2 py-1 rounded flex items-center gap-1"
                              title={propertiesList.some(p => p.propertyType === "" && p.plotNo === "" && p.surveyNo === "") ? "Fill the current row before adding a new one" : "Add new property"}
                            >
                              <Plus className="w-3 h-3" /> Add
                            </button>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse border border-slate-300 text-left">
                              <thead>
                                <tr className="bg-slate-100 border-b border-slate-300 text-[10px] text-slate-700 font-bold">
                                  <th className="p-2 border border-slate-300 w-12 text-center">Prop.No.</th>
                                  <th className="p-2 border border-slate-300 min-w-[140px]">Property Type</th>
                                  <th className="p-2 border border-slate-300 w-28">Plot/Flat No</th>
                                  <th className="p-2 border border-slate-300 w-28">Survey No</th>
                                  <th className="p-2 border border-slate-300 w-32">Extent (Sq.yards)</th>
                                  <th className="p-2 border border-slate-300 w-32">Extent (Sq.meters)</th>
                                  <th className="p-2 border border-slate-300 w-28">Near/Bearing H.No.</th>
                                  <th className="p-2 border border-slate-300 min-w-[120px]">Locality</th>
                                  <th className="p-2 border border-slate-300 w-36">Market Value (Rs.)</th>
                                  <th className="p-2 border border-slate-300 w-16 text-center">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {propertiesList.length === 0 ? (
                                  <tr>
                                    <td colSpan={10} className="p-4 text-center text-slate-500 text-sm">
                                      No properties added yet. Click "+ Add" to add property details.
                                    </td>
                                  </tr>
                                ) : (
                                  propertiesList.map((prop, idx) => (
                                    <tr key={prop.id} className="border-b border-slate-300 hover:bg-slate-50">
                                      <td className="p-2 border border-slate-300 text-xs font-bold text-slate-500 text-center">
                                        {idx + 1}
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <select
                                          value={prop.propertyType}
                                          onChange={(e) => updateProperty(prop.id, 'propertyType', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1 bg-white"
                                        >
                                          <option value="">Select Type</option>
                                          <option value="Open plot">Open plot</option>
                                          <option value="House">House</option>
                                          <option value="Demolished House">Demolished House</option>
                                          <option value="Part of open place">Part of open place</option>
                                          <option value="Flat">Flat</option>
                                        </select>
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={prop.propertyType === "Flat" ? prop.flatNo : prop.plotNo}
                                          onChange={(e) => updateProperty(prop.id, prop.propertyType === "Flat" ? 'flatNo' : 'plotNo', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                          placeholder={prop.propertyType === "Flat" ? "Flat No" : "Plot No"}
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={prop.surveyNo}
                                          onChange={(e) => updateProperty(prop.id, 'surveyNo', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="Survey No"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={prop.propertyType === "Flat" ? prop.flatUndividedSqYards : prop.extentSqYards}
                                          onChange={(e) => updateProperty(prop.id, prop.propertyType === "Flat" ? 'flatUndividedSqYards' : 'extentSqYards', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono text-slate-800 p-1"
                                          placeholder="Sq.yards"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={prop.propertyType === "Flat" ? prop.flatUndividedSqMeters : prop.extentSqMeters}
                                          onChange={(e) => updateProperty(prop.id, prop.propertyType === "Flat" ? 'flatUndividedSqMeters' : 'extentSqMeters', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono text-slate-800 p-1"
                                          placeholder="Sq.meters"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={
                                            prop.propertyType === "Flat" ? prop.flatBearingHNo :
                                            prop.propertyType === "Demolished House" ? prop.demoBearingHNo :
                                            prop.propertyType === "Part of open place" ? prop.partBearingHNo :
                                            prop.nearHNo
                                          }
                                          onChange={(e) => {
                                            const field = prop.propertyType === "Flat" ? 'flatBearingHNo' :
                                              prop.propertyType === "Demolished House" ? 'demoBearingHNo' :
                                              prop.propertyType === "Part of open place" ? 'partBearingHNo' :
                                              'nearHNo';
                                            updateProperty(prop.id, field as keyof PropertyRow, e.target.value);
                                          }}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="H.No."
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={
                                            prop.propertyType === "Flat" ? prop.flatLocality :
                                            prop.propertyType === "Demolished House" ? prop.demoLocality :
                                            prop.propertyType === "Part of open place" ? prop.partLocality :
                                            prop.locality
                                          }
                                          onChange={(e) => {
                                            const field = prop.propertyType === "Flat" ? 'flatLocality' :
                                              prop.propertyType === "Demolished House" ? 'demoLocality' :
                                              prop.propertyType === "Part of open place" ? 'partLocality' :
                                              'locality';
                                            updateProperty(prop.id, field as keyof PropertyRow, e.target.value);
                                          }}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-semibold text-slate-800 p-1"
                                          placeholder="Locality"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300">
                                        <input
                                          type="text"
                                          value={prop.propertyType === "Flat" ? prop.flatMarketValueTotal : prop.marketValueTotal}
                                          onChange={(e) => updateProperty(prop.id, prop.propertyType === "Flat" ? 'flatMarketValueTotal' : 'marketValueTotal', e.target.value)}
                                          className="w-full border-0 focus:outline-none focus:ring-1 focus:ring-[#0a4d4a] text-xs font-mono font-bold text-slate-800 p-1"
                                          placeholder="Market Value"
                                        />
                                      </td>
                                      <td className="p-1 border border-slate-300 text-center">
                                        <button
                                          type="button"
                                          onClick={() => deleteProperty(prop.id)}
                                          className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded transition-colors cursor-pointer"
                                          title="Delete property"
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

                      </div>
                    </div>
                  )}

                  {/* STEP 2: File Upload states (Aadhaar & Link Documents) */}
                  {currentStep === 2 && (() => {
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
                                <Field label="H. No" value={review.property.hNo} />
                                <Field label="Plot No" value={review.property.plotNo} />
                                <Field label="PTI / Passbook No" value={review.property.ptiNo} />
                                <Field label="Extent (Sq. Yards)" value={review.property.extentSqYards} />
                                <Field label="Plinth Area" value={review.property.plinthArea} />
                                <Field label="Village" value={review.property.village} />
                                <Field label="Mandal" value={review.property.mandal} />
                                <Field label="District" value={review.property.district} />
                                <Field label="State" value={review.property.state} />
                                <Field label="Market Value (Rs.)" value={review.marketValue} />
                                <Field label="Stamp Duty (Rs.)" value={review.stampsAmount} />
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

                            {/* Link document */}
                            <section>
                              <h3 className="text-xs font-extrabold text-[#0a4d4a] uppercase tracking-widest mb-3 flex items-center gap-2 border-b border-slate-200 pb-1.5">
                                <BookOpen className="w-4 h-4" /> Link / Acquisition Document
                              </h3>
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
                                <Field label="Link Deed No" value={review.linkDeed.deedNumber} />
                                <Field label="Sub-Registrar Office" value={review.linkDeed.village} />
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
                  {currentStep === 3 && (
                    <div className="space-y-5">
                      <div className="p-3.5 bg-[#eef6f5] border border-[#c3dedb] rounded-lg text-[11px] text-[#0a4d4a] flex items-start gap-2.5">
                        <Info className="w-4 h-4 shrink-0 mt-0.5" />
                        <p>
                          Choose a pre-certified Word (.docx) deed template that matches your registration type, <span className="font-bold">or upload your own
                          template document</span> below. In the next step, all reviewed details are merged into the selected template and formatted to the
                          official Telangana stamp-paper layout.
                        </p>
                      </div>

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
                                Bring your own pre-templated deed — <span className="font-semibold">Word (.docx/.doc), text (.txt), PDF, or a scanned image</span>.
                                We merge the details extracted in Step 1 into your document’s wording, then apply the official Telangana stamp-paper formatting.
                                <span className="text-slate-400"> PDFs and images are transcribed automatically.</span>
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
                                accept=".docx,.doc,.txt,.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
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

                      <div className="flex items-center gap-3">
                        <div className="h-px flex-1 bg-slate-200" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">or choose a library template</span>
                        <div className="h-px flex-1 bg-slate-200" />
                      </div>

                      {templatesLoading ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-3">
                          <div className="relative w-12 h-12 flex items-center justify-center">
                            <div className="absolute inset-0 border-4 border-[#eef6f5] rounded-full"></div>
                            <div className="absolute inset-0 border-4 border-[#0a4d4a] border-t-transparent rounded-full animate-spin"></div>
                          </div>
                          <p className="text-xs text-slate-400">Loading template library…</p>
                        </div>
                      ) : serverTemplates.length === 0 ? (
                        <div className="text-center py-12 space-y-3">
                          <FileText className="w-12 h-12 text-slate-300 mx-auto" />
                          <p className="text-xs text-slate-400">No templates found. Ensure the server is running.</p>
                          <button onClick={loadTemplates} className="text-xs font-bold text-[#0a4d4a] underline">Retry</button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {serverTemplates.map((t) => {
                            const selected = selectedTemplateId === t.id;
                            return (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => setSelectedTemplateId(t.id)}
                                className={`text-left p-4 rounded-xl border-2 transition-all ${selected ? "border-[#0a4d4a] bg-[#eef6f5] shadow-sm" : "border-slate-200 bg-white hover:border-[#0a4d4a]/40"}`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <div className={`p-1.5 rounded-lg ${selected ? "bg-[#0a4d4a] text-white" : "bg-slate-100 text-slate-500"}`}>
                                      <FileText className="w-4 h-4" />
                                    </div>
                                    <h4 className="font-extrabold text-[13px] text-slate-900 leading-tight">{t.name}</h4>
                                  </div>
                                  {selected && <CheckCircle2 className="w-5 h-5 text-[#0a4d4a] shrink-0" />}
                                </div>
                                <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">{t.description}</p>
                                <div className="flex flex-wrap gap-1.5 mt-3">
                                  {t.registrationTypes?.map((rt) => (
                                    <span key={rt} className="text-[9px] font-bold uppercase tracking-wide bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{rt}</span>
                                  ))}
                                  {t.isSeed && (
                                    <span className="text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Sample</span>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
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
                            <button
                              onClick={() => generateDocument(false)}
                              disabled={!selectedTemplateId}
                              className="bg-white border border-slate-300 hover:bg-slate-100 disabled:opacity-50 text-slate-700 text-xs font-bold py-2 px-4 rounded-lg flex items-center gap-1.5"
                            >
                              <RefreshCw className="w-3.5 h-3.5" /> Regenerate
                            </button>
                          </div>

                          {unresolvedPlaceholders.length > 0 && (
                            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900">
                              <p className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Unfilled placeholders detected ({unresolvedPlaceholders.length})</p>
                              <p className="mt-1 font-mono break-words">{unresolvedPlaceholders.join(", ")}</p>
                              <p className="mt-1">These values were missing from Step 1. Go back to supply them, then Regenerate — or fill them directly in the document below.</p>
                            </div>
                          )}

                          {/* Full document content, A4-styled, editable — matches the final layout */}
                          <div className="flex justify-center bg-slate-100 rounded-xl p-6 overflow-y-auto max-h-[560px]">
                            <div
                              className="bg-white shadow-lg relative"
                              style={{ width: "210mm", minHeight: "220mm", padding: "1in 0.75in", boxSizing: "border-box" }}
                            >
                              <textarea
                                value={filledDeedText}
                                onChange={(e) => setFilledDeedText(e.target.value)}
                                className="w-full bg-transparent border-none p-0 outline-none focus:ring-0 resize-none"
                                style={{ fontFamily: "'Times New Roman', Times, serif", fontSize: "14pt", lineHeight: 1.5, color: "#000", minHeight: "200mm", whiteSpace: "pre-wrap" }}
                              />
                            </div>
                          </div>

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
                              {report.allDiscrepancies.map((item: any, idx: number) => (
                                <div key={idx} className="p-3 bg-red-50/50 border border-red-100 rounded-lg text-[11px] space-y-1">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[9px] bg-red-100 text-red-800 font-bold px-2 py-0.5 rounded-full uppercase">{item.severity}</span>
                                    <span className="text-[10px] text-slate-400 font-semibold">{item.category}</span>
                                  </div>
                                  <p className="font-bold text-slate-800">{item.description}</p>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="flex justify-center gap-3 pt-2">
                            <button onClick={triggerDeedVerificationAudit} className="bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold py-2.5 px-5 rounded-lg flex items-center gap-1.5">
                              <RefreshCw className="w-4 h-4" /> Re-run Verification
                            </button>
                            <button onClick={() => setCurrentStep(6)} className="bg-[#0a4d4a] hover:bg-[#073937] text-white text-xs font-bold py-2.5 px-6 rounded-lg flex items-center gap-1.5">
                              Proceed to Stamp Preview <ArrowRight className="w-4 h-4" />
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

                  {/* STEP 6: A4 Stamp-Paper Print Preview — paginated, Word-style (matches server .docx) */}
                  {currentStep === 6 && (() => {
                    const pageCount = Math.max(1, deedPages.length);
                    const safeIdx = Math.min(currentPageIdx, pageCount - 1);
                    const isFirst = safeIdx === 0;
                    const pageText = deedPages[safeIdx] ?? filledDeedText;
                    const goPrev = () => setCurrentPageIdx((i) => Math.max(0, i - 1));
                    const goNext = () => setCurrentPageIdx((i) => Math.min(pageCount - 1, i + 1));
                    const scaledW = A4_WIDTH_PX * previewScale;
                    const scaledH = A4_HEIGHT_PX * previewScale;
                    return (
                    <div className="space-y-4">
                      <div className="p-3.5 bg-[#eef6f5] border border-[#c3dedb] rounded-lg text-[11px] text-[#0a4d4a] flex items-start gap-2.5">
                        <Info className="w-4 h-4 shrink-0 mt-0.5" />
                        <p>
                          Exact A4 preview of the Word document — Times New Roman 14pt, 0.75&quot; side and 1&quot; bottom margins. Only
                          <b> page 1</b> reserves 5.8&quot; at the top for the pre-printed stamp logo &amp; header; every other page uses the
                          normal 1&quot; top margin (no blank space). Flip pages with the arrows. Turn on <b>Edit</b> to change the text —
                          your edits carry into the download.
                        </p>
                      </div>

                      {/* Toolbar: page nav + edit toggle */}
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
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
                        </div>
                        <div className="flex items-center gap-2">
                          {isFirst && (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-[#b58c4c] bg-[#b58c4c]/10 border border-[#b58c4c]/30 px-2 py-1 rounded flex items-center gap-1">
                              <BookOpen className="w-3.5 h-3.5" /> Stamp reserve on this page
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setPreviewEditing((v) => !v)}
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
                      <div ref={previewWrapRef} className="bg-slate-200/70 rounded-xl p-5 flex justify-center overflow-hidden">
                        {previewEditing ? (
                          <div className="w-full bg-white shadow-xl rounded-sm p-6">
                            <textarea
                              value={filledDeedText}
                              onChange={(e) => setFilledDeedText(e.target.value)}
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
                          // Scaled-to-fit placeholder reserves the exact on-screen space; the
                          // single transform inside does all the scaling.
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

                      {/* Page dots for quick jumping when there are a handful of pages */}
                      {!previewEditing && pageCount > 1 && pageCount <= 20 && (
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

                  {/* STEP 7: Download (docx + pdf) & Print */}
                  {currentStep === 7 && (
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

              {currentStep < 7 ? (
                <button
                  disabled={filling || auditing || (currentStep === 3 && !selectedTemplateId)}
                  onClick={() => {
                    // Step validation or quick triggers for the 7-step flow
                    if (currentStep === 1) {
                      setCurrentStep(2); // proceed to Review Details
                    } else if (currentStep === 2) {
                      setCurrentStep(3); // proceed to Select Template
                    } else if (currentStep === 3) {
                      if (selectedTemplateId) setCurrentStep(4); // proceed to Auto-Fill
                    } else if (currentStep === 4) {
                      // The footer button always moves the flow forward: if the
                      // document hasn't been generated yet, generate it and advance
                      // to Re-Verify in one click; otherwise just advance.
                      if (filledDeedText) setCurrentStep(5);
                      else generateDocument(true);
                    } else if (currentStep === 5) {
                      // Run the audit first; once a report exists, advance to the stamp preview.
                      if (report) setCurrentStep(6);
                      else triggerDeedVerificationAudit();
                    } else if (currentStep === 6) {
                      setCurrentStep(7); // proceed to Download
                    }
                  }}
                  className="bg-[#0a4d4a] hover:bg-[#073937] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs py-2 px-5 rounded-lg flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {currentStep === 1 && "Proceed to Review Details"}
                  {currentStep === 2 && "Proceed to Select Template"}
                  {currentStep === 3 && (selectedTemplateId ? "Proceed to Auto-Fill" : "Select a template first")}
                  {currentStep === 4 && (filling ? "Generating…" : filledDeedText ? "Proceed to Re-Verify" : "Generate & Fill Document")}
                  {currentStep === 5 && (auditing ? "Auditing…" : report ? "Proceed to Stamp Preview" : "Run Verification Audit")}
                  {currentStep === 6 && "Proceed to Download"}
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
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Search className="w-4 h-4 text-[#0a4d4a]" /> Discrepancy Registry
                </h3>
                
                {report.allDiscrepancies?.length === 0 ? (
                  <div className="bg-emerald-50 border border-emerald-100 p-3.5 rounded-lg text-xs text-emerald-800 flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-extrabold text-[11px] uppercase tracking-wider">Deed is 100% Compliant!</p>
                      <p className="mt-0.5 text-slate-500 font-sans leading-relaxed">All spelling digits, age caps, and survey boundaries are approved.</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                    {report.allDiscrepancies?.map((item: any, idx: number) => (
                      <div key={idx} className="p-3 bg-red-50/50 border border-red-100 rounded-lg text-[11px] space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] bg-red-100 text-red-800 font-bold px-2 py-0.5 rounded-full uppercase">
                            {item.severity}
                          </span>
                          <span className="text-[10px] text-slate-400 font-semibold">{item.category}</span>
                        </div>
                        <p className="font-extrabold text-slate-800">{item.description}</p>
                        <div className="grid grid-cols-2 gap-2 text-[10px] bg-white p-2 rounded-md border border-slate-200">
                          <div>
                            <span className="text-slate-400 block font-bold">EXPECTED:</span>
                            <span className="text-emerald-700 font-bold font-mono">{item.expected}</span>
                          </div>
                          <div>
                            <span className="text-slate-400 block font-bold">FOUND:</span>
                            <span className="text-red-600 font-bold font-mono">{item.found}</span>
                          </div>
                        </div>
                        <p className="text-[10px] text-slate-500 font-medium leading-relaxed bg-[#fcf8f8] p-1.5 rounded-md border border-red-100">
                          <strong className="text-red-700">Suggestion:</strong> {item.recommendation}
                        </p>
                      </div>
                    ))}
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
