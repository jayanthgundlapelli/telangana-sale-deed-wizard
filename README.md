# Telangana Sale Deed Wizard & Registry

An AI-assisted tool for preparing Telangana property **sale / gift / conveyance
deeds**. It guides you through an **8-step wizard**, uses Google Gemini to extract
data from uploaded documents (Aadhaar cards, link/ownership deeds, supporting
docs), merges the reviewed data into a Word template **in place** (preserving the
template's own formatting), verifies the result, generates a to-scale
**registration plan** from a hand-drawn sketch, and produces a print-ready,
stamp-formatted `.docx` (and PDF where a converter is available) with the plan
appended as the final page.

> **Full-stack TypeScript app:** a React 19 + Vite 6 SPA served by a single Express
> server that also exposes the `/api/*` endpoints and calls Gemini server-side
> (the API key never reaches the browser).

## The 8-step wizard

| # | Step | What it does |
|---|------|--------------|
| 1 | **Registration Form** | Enter bilingual official details (jurisdiction, link-document details incl. Pattadar Passbook / NALA / Layout File, property schedule, boundaries, financials, executant & claimant identities). Upload Aadhaar cards and link documents to auto-fill fields. |
| 2 | **Review Details** | Read-only consolidated review of everything extracted/entered before drafting. |
| 3 | **Select Template** | Choose a deed template (matched to registration type) or upload your own `.docx` / `.doc` / `.txt` / PDF template. |
| 4 | **Auto-Fill Draft** | Merge reviewed data into the chosen template; editable draft preview. |
| 5 | **Re-Verify Deed** | Comprehensive AI cross-check of documents ↔ entered data ↔ deed; lists discrepancies with bilingual (English + Telugu) explanations. |
| 6 | **Stamp Preview** | A4, Times New Roman 14pt, page-1 stamp/header offset; paginated print preview. |
| 7 | **Generate Plan** | Convert a hand-drawn property sketch into a to-scale one-page registration plan (AI extracts the sketch → deterministic SVG render) and cross-check boundaries. |
| 8 | **Download & Print** | Export `.docx` / PDF (with the plan appended as the last page) and print. |

## What's new in this version

This release (`git` commit *"Add plan generator, in-place template fill,
plan-as-last-page & Aadhaar age fixes"*) adds:

- **Registration Plan generator (new `planRenderer.ts`).** Step 7 sends the
  hand-drawn sketch **image** to Gemini, which extracts a structured JSON model
  (title, structure type, parties, polygon geometry, interior boxes, dimension
  labels, area/plinth/scale table). The server then **deterministically renders**
  a full A4 one-pager SVG: auto-fitted to-scale drawing, party labels that adapt
  to the transaction type (Sale → VENDOR/VENDEE, Gift → DONOR/DONEE, etc.),
  area/plinth/scale/index table, north arrow, and signature blocks. Includes
  robust label de-duplication and automatic rotation of long side labels.
- **Registration plan appended as the LAST page of the exported deed.** The
  client rasterises the plan SVG to PNG on a canvas; the server threads it into
  `buildDeedDocx`, which adds a page break + a page-fitted image. Both the Word
  and PDF exports carry the plan page. Strictly conditional — no plan, no extra
  page.
- **In-place `.docx` template fill (new `templateFiller.ts`).** When you upload
  your own template, values are spliced into the original document's XML **in
  place** (via `jszip`), preserving the source template's exact fonts, spacing,
  and layout — even when `<Angle Bracket>` markers are split across runs or line
  breaks. Unresolved markers are left intact (no fabrication) so the Re-Verify
  step can flag them.
- **Aadhaar age fix.** Age is now the *completed* age as of today (month/day
  aware, dynamic current-year) instead of a bare `year` subtraction, and
  year-only DOB cards get a best-effort estimate.
- **Bilingual verification report.** Step-5 discrepancies now carry Telugu
  (`descriptionTe` / `recommendationTe`) strings alongside English.
- **`{{STATEMENT_OF_MARKET_VALUE_TABLE}}`** — a Rule-3 market-value table
  placeholder wired into the deterministic merge path.
- **`jszip` ^3.10.1** pinned as an explicit dependency (used by the in-place
  filler and plan-append flows).

> **Known limitations in this version** (see the code-audit notes): the Step-3
> template *library* is auto-selected but not shown as a clickable list (custom
> upload is the visible control); the final download rebuilds the deed from the
> edited text using the standard A4/Times-New-Roman spec rather than re-emitting
> the in-place-filled bytes; and the Step-7 plan is appended to Word/PDF exports
> but not to the browser **Print** view. See `ARCHITECTURE.md` /
> `.agents/artifacts/deed-app-worklog.md` for the full list.

## Run locally

**Prerequisites:** Node.js 20–22 and a Gemini API key
([get one free](https://aistudio.google.com/apikey)).

```bash
cp .env.example .env.local     # then paste your Gemini key into .env.local
npm install
npm run dev                    # Express server with Vite dev middleware (HMR)
```

Open the URL printed in the terminal (default http://localhost:3000). Without a
key the app still runs in a reduced "heuristic simulation" mode (no live AI).

### Production build

```bash
npm run build                  # builds the SPA + bundles the server → dist/
NODE_ENV=production npm start  # serves the built app on :3000
```

## Scripts

| Script | Does |
|--------|------|
| `npm run dev` | Start the Express server with Vite dev middleware (HMR). |
| `npm run build` | Build the SPA (Vite) and bundle the server to `dist/server.cjs` (esbuild). |
| `npm start` | Run the production bundle (`node dist/server.cjs`). |
| `npm run lint` | Type-check with `tsc --noEmit`. |
| `npm run clean` | Remove `dist/`. |

## Configuration

See `.env.example`. Key variables: `GEMINI_API_KEY` (required for live AI),
`GEMINI_MODEL` (default `gemini-3.5-flash`; switch to `gemini-2.5-flash` /
`-flash-lite` to cut cost), `PORT`, `NODE_ENV`.

## Deploying

- **[DEPLOYMENT.md](DEPLOYMENT.md)** — free dev hosting (Render), production on
  Google Cloud Run with Secret Manager, Firebase notes, and a cost comparison.
  **Read §0 first — there is an exposed API key that must be rotated.**
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — architecture review, the issues found,
  the fixes applied, and the recommended target setup.

The app is deployed on Render at
**https://telangana-sale-deed-wizard.onrender.com** (health check:
`/api/health`).

## Tech stack

React 19 · Vite 6 · Tailwind CSS · Express · TypeScript · Google Gemini
(`@google/genai`) · `docx` (Word generation) · `jszip` (in-place `.docx` edit) ·
`mammoth` / `word-extractor` (template + document parsing).
