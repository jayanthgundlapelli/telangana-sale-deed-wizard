// templateManager.ts
// Manages the library of predefined Word (.docx) deed templates, one per registration
// type. Templates live in ./templates as real .docx files. The USER supplies the final
// official .docx files by dropping them into that folder (filenames listed in the
// manifest). Until then, we auto-seed placeholder .docx files so the flow works E2E.
//
// A template .docx contains {{PLACEHOLDER}} tokens in its body text. We read the text
// out with mammoth, merge the real data, then re-format to the Telangana spec in
// documentBuilder.ts — so the template supplies WORDING, we supply FORMATTING.

import path from "path";
import { promises as fs } from "fs";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
} from "docx";
import mammoth from "mammoth";

export interface DeedTemplateMeta {
  id: string;
  name: string;
  description: string;
  /** Registration / property types this template is intended for. */
  registrationTypes: string[];
  /** .docx filename inside the templates folder. */
  file: string;
  /** True when the file on disk is an auto-generated placeholder, not user-supplied. */
  isSeed?: boolean;
}

export const TEMPLATES_DIR = path.join(process.cwd(), "templates");

// The canonical template library. Replace the .docx files in ./templates with your own;
// keep the filenames (or update them here) and the flow picks them up automatically.
const TEMPLATE_MANIFEST: Omit<DeedTemplateMeta, "isSeed">[] = [
  {
    id: "residential-plot",
    name: "Residential Plot / House Sale Deed",
    description:
      "Standard sale deed for a residential house, open plot, or urban property under the Telangana Stamps Act.",
    registrationTypes: ["Open plot", "House", "Part of open place"],
    file: "residential-plot-sale-deed.docx",
  },
  {
    id: "demolished-house",
    name: "Demolished House Sale Deed",
    description:
      "Sale deed for a property sold as a demolished / vacant structure, capturing the erstwhile house schedule.",
    registrationTypes: ["Demolished House"],
    file: "demolished-house-sale-deed.docx",
  },
  {
    id: "apartment-flat",
    name: "Apartment Flat Conveyance Deed",
    description:
      "Conveyance deed for multi-storey residential apartments, flats, and undivided share of land (UDS).",
    registrationTypes: ["Flat"],
    file: "apartment-flat-conveyance-deed.docx",
  },
  {
    id: "agricultural-land",
    name: "Agricultural Land Sale Deed",
    description:
      "Sale deed for agricultural fields and cultivation plots incorporating Pattadar Passbook references.",
    registrationTypes: ["Agricultural Land"],
    file: "agricultural-land-sale-deed.docx",
  },
];

// Seed body text (with {{PLACEHOLDERS}}) used only to generate placeholder .docx files
// the first time the app runs. User-supplied .docx files override these entirely.
const SEED_TEXT: Record<string, string> = {
  "residential-plot": `SALE DEED (RESIDENTIAL PLOT & HOUSE)

This Deed of Sale is executed on this {{REGISTRATION_DATE}} at {{PROPERTY_VILLAGE}}, {{PROPERTY_DISTRICT}} District, Telangana, by and between:

THE EXECUTANT / SELLER:
Sri/Smt {{SELLER_NAME}}, {{SELLER_RELATION}}, aged about {{SELLER_AGE}}, residing at {{SELLER_ADDRESS}}, holding Aadhaar No {{SELLER_AADHAAR}} and PAN {{SELLER_PAN}} (hereinafter called the "SELLER").

IN FAVOUR OF THE CLAIMANT / BUYER:
Sri/Smt {{BUYER_NAME}}, {{BUYER_RELATION}}, aged about {{BUYER_AGE}}, residing at {{BUYER_ADDRESS}}, holding Aadhaar No {{BUYER_AADHAAR}} and PAN {{BUYER_PAN}} (hereinafter called the "BUYER").

WHEREAS the Seller is the absolute owner and possessor of the residential property bearing H.No {{PROPERTY_HNO}}, Plot No {{PROPERTY_PLOT}}, Survey No {{PROPERTY_SURVEY}}, PTI No {{PROPERTY_PTI}}, admeasuring {{PROPERTY_EXTENT}} with a plinth area of {{PROPERTY_PLINTH}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana.

AND WHEREAS the Seller acquired absolute title through registered link document bearing No {{LINK_DEED_NO}} dated {{LINK_DEED_DATE}} at the Sub-Registrar Office, {{SUB_REGISTRAR}}, SRO Code {{SUB_REGISTRAR_CODE}}.

NOW THIS DEED OF SALE WITNESSETH AS UNDER:
1. That the Seller hereby transfers, sells, and conveys all rights, title, and interest in the scheduled property in favour of the Buyer for the consideration of Rs. {{MARKET_VALUE}}.
2. The Buyer shall henceforth enjoy peaceful and absolute ownership of the property.
3. All taxes, water, and electricity charges stand cleared up to the date of registration.

SCHEDULE OF THE PROPERTY:
All that piece and parcel of residential house & plot bearing H.No {{PROPERTY_HNO}}, Plot No {{PROPERTY_PLOT}}, Survey No {{PROPERTY_SURVEY}}, PTI No {{PROPERTY_PTI}}, measuring {{PROPERTY_EXTENT}} with plinth area {{PROPERTY_PLINTH}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, and bounded as under:

BOUNDARIES:
East by  : {{BOUNDARY_EAST}}
West by  : {{BOUNDARY_WEST}}
North by : {{BOUNDARY_NORTH}}
South by : {{BOUNDARY_SOUTH}}

{{STATEMENT_OF_MARKET_VALUE_TABLE}}

IN WITNESS WHEREOF the Seller and Buyer have signed this Sale Deed on the day, month, and year first written above.

Seller's Signature: __________________        Buyer's Signature: __________________

Witness 1: __________________        Witness 2: __________________`,

  "demolished-house": `SALE DEED (DEMOLISHED HOUSE / VACANT SITE)

This Deed of Sale is executed on this {{REGISTRATION_DATE}} at {{PROPERTY_VILLAGE}}, {{PROPERTY_DISTRICT}} District, Telangana, by and between:

THE EXECUTANT / SELLER:
Sri/Smt {{SELLER_NAME}}, {{SELLER_RELATION}}, aged about {{SELLER_AGE}}, residing at {{SELLER_ADDRESS}}, holding Aadhaar No {{SELLER_AADHAAR}} and PAN {{SELLER_PAN}} (hereinafter called the "SELLER").

IN FAVOUR OF THE CLAIMANT / BUYER:
Sri/Smt {{BUYER_NAME}}, {{BUYER_RELATION}}, aged about {{BUYER_AGE}}, residing at {{BUYER_ADDRESS}}, holding Aadhaar No {{BUYER_AADHAAR}} and PAN {{BUYER_PAN}} (hereinafter called the "BUYER").

WHEREAS the Seller is the absolute owner of the site bearing H.No {{PROPERTY_HNO}}, Plot No {{PROPERTY_PLOT}}, Survey No {{PROPERTY_SURVEY}}, PTI No {{PROPERTY_PTI}}, admeasuring {{PROPERTY_EXTENT}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, whereon the erstwhile residential structure has been fully demolished and the property is now conveyed as a vacant site.

AND WHEREAS the Seller acquired absolute title through registered link document bearing No {{LINK_DEED_NO}} dated {{LINK_DEED_DATE}}.

NOW THIS DEED OF SALE WITNESSETH:
1. That the Seller sells and conveys the vacant demolished-house site in favour of the Buyer for Rs. {{MARKET_VALUE}}.
2. The Buyer shall enjoy absolute ownership of the site henceforth.

SCHEDULE OF THE PROPERTY:
All that vacant site (post-demolition) bearing H.No {{PROPERTY_HNO}}, Plot No {{PROPERTY_PLOT}}, Survey No {{PROPERTY_SURVEY}}, PTI No {{PROPERTY_PTI}}, measuring {{PROPERTY_EXTENT}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, bounded as under:

BOUNDARIES:
East by  : {{BOUNDARY_EAST}}
West by  : {{BOUNDARY_WEST}}
North by : {{BOUNDARY_NORTH}}
South by : {{BOUNDARY_SOUTH}}

IN WITNESS WHEREOF the parties have signed this Sale Deed on the day, month, and year first written above.

Seller's Signature: __________________        Buyer's Signature: __________________

Witness 1: __________________        Witness 2: __________________`,

  "apartment-flat": `DEED OF CONVEYANCE (APARTMENT FLAT)

This Deed of Conveyance is executed on this {{REGISTRATION_DATE}} at {{PROPERTY_VILLAGE}}, {{PROPERTY_DISTRICT}} District, Telangana, by and between:

VENDOR / SELLER:
Sri/Smt {{SELLER_NAME}}, {{SELLER_RELATION}}, aged about {{SELLER_AGE}}, residing at {{SELLER_ADDRESS}}, holding Aadhaar No {{SELLER_AADHAAR}} and PAN {{SELLER_PAN}}.

PURCHASER / BUYER:
Sri/Smt {{BUYER_NAME}}, {{BUYER_RELATION}}, aged about {{BUYER_AGE}}, residing at {{BUYER_ADDRESS}}, holding Aadhaar No {{BUYER_AADHAAR}} and PAN {{BUYER_PAN}}.

WHEREAS the Seller is the sole and absolute owner of Flat No {{PROPERTY_PLOT}} situated at H.No {{PROPERTY_HNO}}, Survey No {{PROPERTY_SURVEY}}, PTI No {{PROPERTY_PTI}}, with a plinth area of {{PROPERTY_PLINTH}} and an undivided share of land (UDS) of {{PROPERTY_EXTENT}}, at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, acquired through Registered Deed No {{LINK_DEED_NO}} dated {{LINK_DEED_DATE}}.

NOW THIS DEED WITNESSETH that the Seller conveys the said flat to the Buyer for Rs. {{MARKET_VALUE}}.

SCHEDULE OF THE FLAT:
Flat No {{PROPERTY_PLOT}} with a built-up plinth area of {{PROPERTY_PLINTH}} together with undivided land share {{PROPERTY_EXTENT}}, in H.No {{PROPERTY_HNO}}, Survey No {{PROPERTY_SURVEY}}, PTI No {{PROPERTY_PTI}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, bounded as under:

BOUNDARIES:
East by  : {{BOUNDARY_EAST}}
West by  : {{BOUNDARY_WEST}}
North by : {{BOUNDARY_NORTH}}
South by : {{BOUNDARY_SOUTH}}

IN WITNESS WHEREOF the parties have set their signatures on this Conveyance Deed.

Seller's Signature: __________________        Buyer's Signature: __________________

Witness 1: __________________        Witness 2: __________________`,

  "agricultural-land": `SALE DEED (AGRICULTURAL LAND)

This Deed of Sale is executed on this {{REGISTRATION_DATE}} at {{PROPERTY_VILLAGE}}, {{PROPERTY_DISTRICT}} District, Telangana, by and between:

THE SELLER (PATTADAR):
Sri/Smt {{SELLER_NAME}}, {{SELLER_RELATION}}, aged about {{SELLER_AGE}}, residing at {{SELLER_ADDRESS}}, holding Aadhaar No {{SELLER_AADHAAR}} and PAN {{SELLER_PAN}}.

IN FAVOUR OF THE BUYER:
Sri/Smt {{BUYER_NAME}}, {{BUYER_RELATION}}, aged about {{BUYER_AGE}}, residing at {{BUYER_ADDRESS}}, holding Aadhaar No {{BUYER_AADHAAR}} and PAN {{BUYER_PAN}}.

WHEREAS the Seller is the absolute Pattadar and possessor of agricultural land admeasuring {{PROPERTY_EXTENT}} in Survey No {{PROPERTY_SURVEY}}, under Pattadar Passbook / PTI No {{PROPERTY_PTI}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, acquired via registered link document No {{LINK_DEED_NO}} dated {{LINK_DEED_DATE}}.

NOW THIS DEED WITNESSETH that the Seller conveys the said agricultural land to the Buyer for Rs. {{MARKET_VALUE}}.

SCHEDULE OF THE AGRICULTURAL PROPERTY:
All that piece and parcel of agricultural land measuring {{PROPERTY_EXTENT}} in Survey No {{PROPERTY_SURVEY}}, registered with passbook {{PROPERTY_PTI}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, bounded as under:

BOUNDARIES:
East by  : {{BOUNDARY_EAST}}
West by  : {{BOUNDARY_WEST}}
North by : {{BOUNDARY_NORTH}}
South by : {{BOUNDARY_SOUTH}}

IN WITNESS WHEREOF the parties have set their hands on the day, month, and year abovementioned.

Seller's Signature: __________________        Buyer's Signature: __________________

Witness 1: __________________        Witness 2: __________________`,
};

// Build a minimal .docx (placeholders preserved verbatim) for seeding the folder.
async function seedDocxBuffer(text: string): Promise<Buffer> {
  const paragraphs = text.split("\n").map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line, font: "Times New Roman", size: 28 })],
        alignment: AlignmentType.LEFT,
      })
  );
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}

/** Ensure the templates folder exists and every manifest file is present (seed if absent). */
export async function ensureTemplatesSeeded(): Promise<void> {
  await fs.mkdir(TEMPLATES_DIR, { recursive: true });
  for (const meta of TEMPLATE_MANIFEST) {
    const filePath = path.join(TEMPLATES_DIR, meta.file);
    try {
      await fs.access(filePath);
    } catch {
      const seed = SEED_TEXT[meta.id];
      if (seed) {
        await fs.writeFile(filePath, await seedDocxBuffer(seed));
        console.log(`Seeded placeholder template: ${meta.file}`);
      }
    }
  }
}

/** List templates that actually exist on disk, flagging which are still auto-seeded. */
export async function listTemplates(): Promise<DeedTemplateMeta[]> {
  await ensureTemplatesSeeded();
  const out: DeedTemplateMeta[] = [];
  for (const meta of TEMPLATE_MANIFEST) {
    const filePath = path.join(TEMPLATES_DIR, meta.file);
    let exists = false;
    let isSeed = false;
    try {
      await fs.access(filePath);
      exists = true;
      // A file is considered "seed" only if we have never been told otherwise;
      // we treat presence of a matching seed text + small size as a heuristic.
      const stat = await fs.stat(filePath);
      isSeed = stat.size < 12000 && !!SEED_TEXT[meta.id];
    } catch {
      exists = false;
    }
    if (exists) out.push({ ...meta, isSeed });
  }
  return out;
}

/** Read a template .docx by id and return its raw text (placeholders preserved). */
export async function getTemplateText(id: string): Promise<string | null> {
  const meta = TEMPLATE_MANIFEST.find((t) => t.id === id);
  if (!meta) return null;
  await ensureTemplatesSeeded();
  const filePath = path.join(TEMPLATES_DIR, meta.file);
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return (result?.value ?? "").trim();
  } catch (err) {
    console.warn(`Failed to read template ${id}:`, err);
    // Fall back to the seed text so the flow never hard-fails.
    return SEED_TEXT[id] ?? null;
  }
}

export function getTemplateMeta(id: string): DeedTemplateMeta | undefined {
  return TEMPLATE_MANIFEST.find((t) => t.id === id);
}
