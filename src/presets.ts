export interface MockFile {
  name: string;
  size: string;
  mimeType: string;
  base64?: string;
  presetText?: string;
  isMock: boolean;
}

export interface Preset {
  id: string;
  title: string;
  description: string;
  registrationDate: string;
  draftText: string;
  aadhaarCards: MockFile[];
  linkDocuments: MockFile[];
}

export interface ModelTemplate {
  id: string;
  name: string;
  description: string;
  templateText: string;
}

export const MODEL_TEMPLATES: ModelTemplate[] = [
  {
    id: "residential-plot",
    name: "Residential Plot Sale Deed Draft",
    description: "Standard sale deed for residential house, open plot, or urban property under Telangana Stamps Act.",
    templateText: `SALE DEED (RESIDENTIAL PLOT & HOUSE)

This Deed of Sale is executed on this {{REGISTRATION_DATE}} at Telangana, by and between:

THE EXECUTANT / SELLER:
Sri/Smt {{SELLER_NAME}}, {{SELLER_RELATION}}, aged about {{SELLER_AGE}}, Occupation: Business/Service, residing at {{SELLER_ADDRESS}}, holding Aadhaar Card No: {{SELLER_AADHAAR}} and PAN Card No: {{SELLER_PAN}}.
(hereinafter called the "SELLER", which expression shall mean and include his/her heirs, executors, and administrators).

IN FAVOR OF THE CLAIMANT / BUYER:
Sri/Smt {{BUYER_NAME}}, {{BUYER_RELATION}}, aged about {{BUYER_AGE}}, Occupation: Business/Service, residing at {{BUYER_ADDRESS}}, holding Aadhaar Card No: {{BUYER_AADHAAR}} and PAN Card No: {{BUYER_PAN}}.
(hereinafter called the "BUYER", which expression shall mean and include his/her heirs, executors, and administrators).

WHEREAS the Seller is the absolute owner, titleholder, and possessor of the residential property situated at H.No {{PROPERTY_HNO}}, Plot No {{PROPERTY_PLOT}}, under Survey Number {{PROPERTY_SURVEY}}, covered with Property Tax PTI No: {{PROPERTY_PTI}}, admeasuring {{PROPERTY_EXTENT}} (with a Plinth Area of {{PROPERTY_PLINTH}}), situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana.

AND WHEREAS the Seller acquired absolute title to the said property through a registered link sale deed document bearing Number {{LINK_DEED_NO}} registered at Sub-Registrar Office, {{PROPERTY_VILLAGE}} on {{LINK_DEED_DATE}}.

NOW THIS DEED OF SALE WITNESSETH AS UNDER:
1. That the Seller hereby transfers, sells, and conveys all rights, title, and interest in the scheduled property in favor of the Buyer.
2. The Buyer shall enjoy peaceful and absolute ownership of the property henceforth.
3. All taxes, water rates, and electrical charges have been cleared up to the date of registration.

SCHEDULE OF THE PROPERTY:
All that piece and parcel of residential house & plot bearing H.No {{PROPERTY_HNO}}, Plot No {{PROPERTY_PLOT}}, Survey No {{PROPERTY_SURVEY}}, PTI No: {{PROPERTY_PTI}}, measuring {{PROPERTY_EXTENT}} with plinth area {{PROPERTY_PLINTH}} situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, and bounded as under:

BOUNDARIES:
East by   : {{BOUNDARY_EAST}}
West by   : {{BOUNDARY_WEST}}
North by  : {{BOUNDARY_NORTH}}
South by  : {{BOUNDARY_SOUTH}}

In witness whereof, the Seller and Buyer have signed this Sale Deed on the day, month, and year first written above.

Sellers Sign: __________________             Buyers Sign: __________________

Witness 1: __________________               Witness 2: __________________`
  },
  {
    id: "agricultural-land",
    name: "Agricultural Land Sale Deed Draft",
    description: "Legal draft for agricultural fields, land holdings, and cultivation plots incorporating Pattadar Passbooks.",
    templateText: `SALE DEED (AGRICULTURAL LAND)

This Deed of Sale is executed on this {{REGISTRATION_DATE}} at Telangana, by and between:

THE SELLER (PATTADAR):
Sri/Smt {{SELLER_NAME}}, {{SELLER_RELATION}}, aged about {{SELLER_AGE}}, Occupation: Agriculture, residing at {{SELLER_ADDRESS}}, holding Aadhaar Card No: {{SELLER_AADHAAR}} and PAN Card No: {{SELLER_PAN}}.
(hereinafter referred to as the "SELLER").

IN FAVOR OF THE BUYER:
Sri/Smt {{BUYER_NAME}}, {{BUYER_RELATION}}, aged about {{BUYER_AGE}}, Occupation: Agriculture/Business, residing at {{BUYER_ADDRESS}}, holding Aadhaar Card No: {{BUYER_AADHAAR}} and PAN Card No: {{BUYER_PAN}}.
(hereinafter referred to as the "BUYER").

WHEREAS the Seller is the absolute Pattadar, owner, and possessor of the Agricultural Land admeasuring {{PROPERTY_EXTENT}} situated in Survey Number {{PROPERTY_SURVEY}}, under Pattadar Passbook / PTI No: {{PROPERTY_PTI}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, which was acquired via registered link deed/document no. {{LINK_DEED_NO}} dated {{LINK_DEED_DATE}}.

AND WHEREAS the Seller has offered to sell the agricultural land to the Buyer for agricultural purposes, and the Buyer has accepted the same.

SCHEDULE OF THE AGRICULTURAL PROPERTY:
All that piece and parcel of Agricultural Land measuring {{PROPERTY_EXTENT}} in Survey Number {{PROPERTY_SURVEY}}, registered with passbook {{PROPERTY_PTI}}, situated in {{PROPERTY_VILLAGE}} Village and Mandal, {{PROPERTY_DISTRICT}} District, Telangana, bounded as follows:

BOUNDARIES OF AGRICULTURAL PLOT:
East by   : {{BOUNDARY_EAST}}
West by   : {{BOUNDARY_WEST}}
North by  : {{BOUNDARY_NORTH}}
South by  : {{BOUNDARY_SOUTH}}

In witness whereof, the parties hereunto set their hands and seals on the day, month, and year abovementioned.

Sellers Sign: __________________             Buyers Sign: __________________

Witness 1: __________________               Witness 2: __________________`
  },
  {
    id: "apartment-flat",
    name: "Apartment Flat Conveyance Deed Draft",
    description: "Sale deed draft for multi-story residential apartments, flats, and undivided shares of land (UDS).",
    templateText: `DEED OF CONVEYANCE (APARTMENT FLAT)

This Deed of Conveyance is executed on this {{REGISTRATION_DATE}} at Telangana, by and between:

VENDOR / SELLER:
Sri/Smt {{SELLER_NAME}}, {{SELLER_RELATION}}, aged about {{SELLER_AGE}}, residing at {{SELLER_ADDRESS}}, holding Aadhaar Card No: {{SELLER_AADHAAR}} and PAN Card No: {{SELLER_PAN}}.

PURCHASER / BUYER:
Sri/Smt {{BUYER_NAME}}, {{BUYER_RELATION}}, aged about {{BUYER_AGE}}, residing at {{BUYER_ADDRESS}}, holding Aadhaar Card No: {{BUYER_AADHAAR}} and PAN Card No: {{BUYER_PAN}}.

WHEREAS the Seller is the sole and absolute owner of Flat No {{PROPERTY_PLOT}} on the Floor of the building known as "RESIDENCY", situated at H.No {{PROPERTY_HNO}}, Survey No {{PROPERTY_SURVEY}}, PTI No: {{PROPERTY_PTI}}, with a Plinth Area of {{PROPERTY_PLINTH}} and an Undivided Share of Land (UDS) of {{PROPERTY_EXTENT}} out of the total plot area, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, acquired through Registered Deed No {{LINK_DEED_NO}} dated {{LINK_DEED_DATE}}.

SCHEDULE OF THE FLAT:
Flat No {{PROPERTY_PLOT}}, with a built-up plinth area of {{PROPERTY_PLINTH}} together with undivided land share {{PROPERTY_EXTENT}}, in H.No {{PROPERTY_HNO}}, Survey No {{PROPERTY_SURVEY}}, PTI No: {{PROPERTY_PTI}}, situated at {{PROPERTY_VILLAGE}} Village, {{PROPERTY_MANDAL}} Mandal, {{PROPERTY_DISTRICT}} District, Telangana, bounded as follows:

BOUNDARIES OF FLAT / BUILDING:
East by   : {{BOUNDARY_EAST}}
West by   : {{BOUNDARY_WEST}}
North by  : {{BOUNDARY_NORTH}}
South by  : {{BOUNDARY_SOUTH}}

IN WITNESS WHEREOF the parties have set their signatures on this Conveyance Deed.

Sellers Sign: __________________             Buyers Sign: __________________

Witness 1: __________________               Witness 2: __________________`
  }
];

export const PRESETS: Preset[] = [
  {
    id: "perfect-match",
    title: "Scenario 1: Perfect Match (Nakrekal Property)",
    description: "Sellers match Aadhaar exactly. Telugu Link Doc transliterates correctly to English. All property details, boundaries, PTI number, and sq yards match.",
    registrationDate: "2026-07-13",
    aadhaarCards: [
      {
        name: "Aadhaar_Srinivas_Ankem.pdf",
        size: "185 KB",
        mimeType: "application/pdf",
        isMock: true,
        presetText: `GOVERNMENT OF INDIA (భారత ప్రభుత్వం)
UNIQUE IDENTIFICATION AUTHORITY OF INDIA
Enrollment No: 1024/55214/09874

Ankem Srinivas (అంకెమ్ శ్రీనివాస్)
S/o: Ankem Ramulu (అంకెమ్ రాములు)
Date of Birth (పుట్టిన తేదీ): 12/06/1975
Gender (లింగము): MALE / పురుషుడు

Aadhaar Number (ఆధార్ సంఖ్య): 4521 8902 3412

Address: H.No 4-12, Near Hanuman Temple, Nakrekal Village, Nakrekal Mandal, Nalgonda District, Telangana - 508211`
      }
    ],
    linkDocuments: [
      {
        name: "Link_Deed_Telugu_1998.pdf",
        size: "1.2 MB",
        mimeType: "application/pdf",
        isMock: true,
        presetText: `రిజిస్ట్రేషన్ మరియు ముద్రల శాఖ, తెలంగాణ ప్రభుత్వం (Deed of Sale)
Document Number: Book I - 1204/1998
Date of Execution: 14th August 1998

విక్రయదారుడు (Seller):
అంకెమ్ శ్రీనివాస్ (Ankem Srinivas), తండ్రి పేరు: అంకెమ్ రాములు (Ankem Ramulu), వయస్సు: 23 సంవత్సరాలు (in 1998), నివాసం: నకిరేకల్.

ఆస్తి వివరములు (Property Details):
నల్గొండ జిల్లా, నకిరేకల్ మండలం, నకిరేకల్ గ్రామ పరిధిలో గల వ్యవసాయ ఇల్లు మరియు స్థలము.
ఇంటి నెంబరు (H.No): 4-12
ప్లాట్ నెంబరు (Plot No): 12
సర్వే నంబరు (Survey Number): 412/A
పి.టి.ఐ. నెంబరు (PTI No): 1092003412
విస్తీర్ణం (Extent): 240 చదరపు గజములు (240 Sq Yards)
ప్లింత్ ఏరియా (Plinth Area): 1500 చదరపు అడుగులు (1500 Sq Ft)

సహజ సరిహద్దులు (Boundaries):
తూర్పు (East): కాలువ (Canal)
పడమర (West): రాములు భూమి (Ramulu's Land)
ఉత్తరం (North): రోడ్డు (Main Road)
دక్షిణం (South): వెంకటయ్య భూమి (Venkataiah's Land)`
      }
    ],
    draftText: `SALE DEED

This Deed of Sale is executed on this 13th day of July, 2026 at Nakrekal, Nalgonda District, Telangana, by:

SELLER:
Sri Ankem Srinivas, S/o Ramulu, aged about 51 Years, Occupation: Agriculture, residing at H.No 4-12, Nakrekal Village and Mandal, Nalgonda District, Telangana, holding Aadhaar Card No: 4521 8902 3412.

In favor of the BUYER:
Sri Ganta Venkat Reddy, S/o Ganta Malla Reddy, aged about 45 Years, Occupation: Business, residing at Hyderabad.

WHEREAS the Seller is the absolute owner and possessor of the residential building situated at H.No 4-12, Plot No 12, under Survey Number 412/A, covered with PTI No: 1092003412, admeasuring 240 Sq Yards, with a Plinth Area of 1500 Sq Ft, situated at Nakrekal Village and Mandal, Nalgonda District, which was acquired via registered link sale deed document no. 1204/1998.

BOUNDARIES OF THE PROPERTY:
East: Canal
West: Ramulu's Land
North: Main Road
South: Venkataiah's Land

In witness whereof, the Seller has signed this Sale Deed on the day, month and year first above written.`
  },
  {
    id: "warangal-mismatch",
    title: "Scenario 2: Warangal Mismatches (Names & Typos)",
    description: "Contains critical typos. Seller's name has spelling variation, PTI tax number mismatch, H.No omission, and link document deed number typo.",
    registrationDate: "2026-07-13",
    aadhaarCards: [
      {
        name: "Aadhaar_Ankem_Srinivas_Rao.pdf",
        size: "192 KB",
        mimeType: "application/pdf",
        isMock: true,
        presetText: `GOVERNMENT OF INDIA
UNIQUE IDENTIFICATION AUTHORITY OF INDIA

Ankem Srinivas (అంకెమ్ శ్రీనివాస్)
S/o: Ankem Ramulu
Date of Birth: 12/06/1975
Gender: MALE

Aadhaar Number: 4521 8902 3412

Address: H.No 4-12/A, Nakrekal Mandal, Nalgonda, Telangana - 508211`
      }
    ],
    linkDocuments: [
      {
        name: "Link_Deed_English_Nakrekal.pdf",
        size: "950 KB",
        mimeType: "application/pdf",
        isMock: true,
        presetText: `REGISTRATION AND STAMPS DEPARTMENT, GOVT OF AP (1998)
Document Number: Book I - 2304/1998
Date of Execution: 20th November 1998

VENDOR (Seller):
Ankem Srinivas, S/o Ramulu, age 23 in 1998.

PROPERTY DESCRIPTION:
House on Plot No 18, Survey No 412/A, PTI No 1092003415, House No. 4-12/A, measuring 300 Sq Yards with plinth area of 1800 Sq Ft situated at Nakrekal.

BOUNDARIES:
East: Canal, West: Ramulu's Land, North: Main Road, South: Venkataiah's Land`
      }
    ],
    draftText: `SALE DEED

This Deed of Sale is executed on this 13th day of July, 2026 at Nakrekal, Nalgonda, by:

SELLER:
Sri Ankem Srinivasa Rao, S/o Ramulu, aged about 46 Years, Occupation: Business, residing at H.No 4-12, Nakrekal, holding Aadhaar Card No: 4521 8902 3412.

In favor of the BUYER:
Sri Ganta Venkat Reddy, S/o Ganta Malla Reddy, residing at Hyderabad.

WHEREAS the Seller is the absolute owner and possessor of the house on Plot No 15, under Survey Number 412/A, covered with PTI No: 1092003999, admeasuring 250 Sq Yards, with a Plinth Area of 1600 Sq Ft, situated at Nakrekal, which was acquired via registered link sale deed document no. 2340/1998.

BOUNDARIES OF THE PROPERTY:
East: Road
West: Open Plot
North: Neighbor
South: Drain

In witness whereof, the Seller has signed this Sale Deed on the day, month and year first above written.`
  },
  {
    id: "telugu-mismatch",
    title: "Scenario 3: Medak Telugu Deed Mismatch",
    description: "Medak Agricultural Land. The original Telugu Pattadar Passbook has survey 102/AA but draft has survey typo 120/AA. Boundaries are translated incorrectly.",
    registrationDate: "2026-07-13",
    aadhaarCards: [
      {
        name: "Aadhaar_Kethavath_Ramulu.pdf",
        size: "172 KB",
        mimeType: "application/pdf",
        isMock: true,
        presetText: `GOVERNMENT OF INDIA (భారత ప్రభుత్వం)

Kethavath Ramulu (కేతావత్ రాములు)
S/o: Kethavath Laxma (కేతావత్ లక్ష్మ)
DOB: 01/01/1968
Gender: MALE

Aadhaar Number: 9874 5612 3045

Address: Haveli Ghanpur Village, Medak District, Telangana - 502113`
      }
    ],
    linkDocuments: [
      {
        name: "Pattadar_Passbook_Telugu.pdf",
        size: "1.4 MB",
        mimeType: "application/pdf",
        isMock: true,
        presetText: `తెలంగాణ ప్రభుత్వం (Pattadar Passbook - Dharani portal)
Pattadar PP Number: PP-5049/2010
Village: Haveli Ghanpur, Mandal: Haveli Ghanpur, District: Medak

పట్టాదారుడు (Pattadar):
కేతావత్ రాములు (Kethavath Ramulu), తండ్రి: కేతావత్ లక్ష్మ.

భూమి వివరాలు (Land details):
సర్వే నంబరు (Survey No): 102/AA
ఖాతా నంబరు (Khata No): 341
విస్తీర్ణం (Extent): 2.50 ఎకరాలు (2.50 Acres)
PTI / భూమి పన్ను నంబరు: 1088009944

వ్యవసాయ భూమి సరిహద్దులు (Agricultural Boundaries):
తూర్పు (East): రాము భూమి (Ramu's Land)
పడమర (West): శేఖర్ భూమి (Sekhar's Land)
ఉత్తరం (North): కాలువ (Canal)
దక్షిణం (South): చెరువు (Pond)`
      }
    ],
    draftText: `SALE DEED

This Deed of Sale is executed on this 13th day of July, 2026 at Haveli Ghanpur, Medak, by:

SELLER:
Sri K. Ramu, S/o Kethavath Laxma, aged about 58 Years, Occupation: Agriculture, residing at Haveli Ghanpur, Medak, holding Aadhaar Card No: 9874 5612 3045.

In favor of the BUYER:
Sri Vangala Sudhakar, S/o Vangala Narsaiah, residing at Medak.

WHEREAS the Seller is the absolute Pattadar and owner of the agricultural land measuring 2.10 Acres in Survey Number 120/AA, covered with PTI No: 1088009000, situated at Haveli Ghanpur Village, which was acquired via Pattadar Passbook No. PP-5000/2010.

BOUNDARIES OF THE LAND:
East: State Highway
West: Forest Land
North: Open space
South: Main Road

In witness whereof, the parties have signed this Sale Deed.`
  }
];
