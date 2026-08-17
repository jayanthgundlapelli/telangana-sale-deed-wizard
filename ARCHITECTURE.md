# Architecture — Telangana Sale Deed Wizard & Registry

_Last reviewed against the codebase on 2026-08-17._

A single-deployable **full-stack TypeScript** application that guides a user
through preparing a Telangana property **sale / gift / conveyance deed**,
verifies it against source documents with Google Gemini, generates a to-scale
**registration plan** from a hand-drawn sketch, and exports a stamp-formatted
`.docx` / PDF (plan appended as the last page).

Live demo: https://telangana-sale-deed-wizard.onrender.com  
Health: `GET /api/health`

---

## 1. System overview

```
┌──────────────────────────── Browser ────────────────────────────┐
│  React 19 SPA (src/App.tsx ~7.9k LOC)                            │
│  • Dual mode: Generate (8 steps) | Verify (3 steps)              │
│  • localStorage: telangana_deeds_registry (draft registry)       │
│  • Client rasterises plan SVG → PNG before export                │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTPS  /api/*
                                ▼
┌───────────────────────── Express (server.ts) ───────────────────┐
│  Serves SPA (Vite HMR in dev · dist/ in prod)                    │
│  Gemini calls stay server-side (GEMINI_API_KEY never in browser) │
│  LibreOffice (soffice) for optional DOCX → PDF                   │
└───────┬───────────────────┬───────────────────┬─────────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
  Google Gemini API   ./templates/*.docx   Ephemeral /tmp
  (vision + text)     (self-seeding lib)   (PDF conversion)
```

**No database.** Request payloads carry all working state. The only durable
server artifact is the on-disk template library (baked into the container /
self-seeded on boot). The browser keeps a lightweight deed draft registry in
`localStorage`.

---

## 2. Runtime & deployment topology

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | Node.js **20–22** | Pinned via `engines` + Dockerfile `node:20-alpine` |
| Process model | **One long-lived Express process** | Serves SPA + API; not serverless |
| Dev | `tsx server.ts` + Vite middleware | HMR; lazy `import("vite")` only in non-prod |
| Prod build | Vite SPA → `dist/` + esbuild → `dist/server.cjs` | `--packages=external` |
| Container | Multi-stage Dockerfile | Runtime includes LibreOffice + Liberation fonts |
| Hosts | Render (Docker free) · Cloud Run | `render.yaml`, `cloudbuild.yaml` |

Scale characteristics: **stateless** request handlers → horizontal scale and
scale-to-zero are fine. Ephemeral filesystem is acceptable because templates
self-seed and exports stream to the client.

---

## 3. Product flows

### 3.1 Generate flow (8 steps)

| # | Step | Responsibility |
|---|------|----------------|
| 1 | **Registration Form** | Bilingual official details; Aadhaar + link-document uploads → `/api/extract-aadhaar`, `/api/extract-link-document` |
| 2 | **Review Details** | Read-only consolidation of entered/extracted facts |
| 3 | **Select Template** | Library templates (`/api/templates`) or bring-your-own `.docx` / `.doc` / `.txt` / PDF |
| 4 | **Auto-Fill Draft** | Merge into template via `/api/generate-document` (in-place fill or placeholder merge); optional `/api/fill-template`, `/api/translate-deed`, `/api/clean-draft` |
| 5 | **Re-Verify Deed** | `/api/verify` — documents ↔ form ↔ draft; bilingual discrepancies |
| 6 | **Generate Plan** | Hand sketch → `/api/generate-plan` → structured JSON → deterministic SVG |
| 7 | **Stamp Preview** | A4 / Times New Roman 14pt / page-1 stamp offset preview |
| 8 | **Download & Print** | `/api/export-document` (`.docx` or PDF); plan PNG + optional Aadhaar image page |

### 3.2 Verify flow (3 steps)

Reuses Step-1 form + the same audit engine:

1. Registration Form  
2. Upload finished deed (`.docx` / `.doc`)  
3. Cross-check via `/api/verify` (+ `/api/export-verification-report`)

Mode is toggled in the SPA (`flowMode`: `"generate"` | `"verify"`).

---

## 4. Module map

```
┌─ Frontend ─────────────────────────────────────────────────────┐
│  src/main.tsx              entry                                 │
│  src/App.tsx               wizard UI, state, all client orchestration │
│  src/DocxLivePreview.tsx   docx-preview live Word rendering      │
│  src/AiStatusBanner.tsx    AI failure / degraded-mode UX         │
│  src/aiError.ts            client-side error presentation        │
│  src/presets.ts            sample / demo form presets            │
└────────────────────────────────────────────────────────────────┘

┌─ Backend core ─────────────────────────────────────────────────┐
│  server.ts (~2.9k)         Express app, Gemini orchestration,    │
│                            model failover, all /api routes       │
│  aiErrors.ts               Classify AI failures; timeouts;       │
│                            never silently succeed on AI failure  │
└────────────────────────────────────────────────────────────────┘

┌─ Document pipeline ────────────────────────────────────────────┐
│  templateManager.ts        Template library + self-seed          │
│  templateFiller.ts         In-place .docx XML fill (jszip);      │
│                            split-run / <w:br/> aware; multi-party│
│  documentBuilder.ts        Deterministic A4 stamp-spec .docx;    │
│                            plan append; verification report DOCX │
│  planRenderer.ts           Vision schema + reconstruct geometry; │
│                            SVG A4 registration plan              │
│  planDocxRenderer.ts       Optional editable DrawingML plan page │
└────────────────────────────────────────────────────────────────┘
```

### Design principle: AI extracts, code decides

| Concern | Who owns it |
|---------|-------------|
| OCR / field extraction from Aadhaar, link docs, sketches | Gemini (vision) |
| Deed verification / discrepancy language (EN + TE) | Gemini (text) |
| Plot geometry, north-up layout, to-scale roads | **`planRenderer.ts`** (deterministic) |
| Stamp-paper margins, fonts, page breaks | **`documentBuilder.ts`** |
| Preserving uploaded template formatting | **`templateFiller.ts`** (edit `<w:t>` only) |
| Failure classification & user messaging | **`aiErrors.ts`** |

This split keeps legal formatting and surveying rules testable and stable even
when the model changes.

---

## 5. API surface

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/health` | GET | Liveness (Docker / Render / Cloud Run) |
| `/api/templates` | GET | List deed templates |
| `/api/extract` | POST | Structured extraction from uploaded deed |
| `/api/extract-aadhaar` | POST | Aadhaar field extraction |
| `/api/extract-link-document` | POST | Link / ownership document extraction |
| `/api/parse-doc` | POST | Legacy `.doc` / `.docx` → text |
| `/api/extract-template-text` | POST | Pull plain text from a template file |
| `/api/generate-document` | POST | Merge reviewed data into chosen template |
| `/api/fill-template` | POST | AI-assisted template fill |
| `/api/clean-draft` | POST | Clean / normalise draft text |
| `/api/translate-deed` | POST | On-demand Telugu translation of draft |
| `/api/pre-audit` | POST | Early cross-check before full draft |
| `/api/verify` | POST | Full documents ↔ data ↔ deed audit |
| `/api/export-verification-report` | POST | Verification report as `.docx` |
| `/api/generate-plan` | POST | Sketch → structured plan + boundary audit + SVG |
| `/api/export-document` | POST | Final `.docx` or PDF (+ plan / images pages) |

Body size limit: **50 MB** (base64 uploads for scans and filled templates).

---

## 6. Key pipelines

### 6.1 Template fill

```
Custom .docx upload ──► fillDocxTemplate (templateFiller)
                          • angle-bracket / {{PLACEHOLDER}} resolve
                          • multi-party paragraph expansion
                          • unresolved markers left intact for re-verify
Library template ─────► mammoth text → mergePlaceholders → buildDeedDocx
                          • wording from template, formatting from code
```

Export prefers the **already-filled** `filledDocxBase64` bytes so download
matches the stamp preview (tables, fonts, page breaks preserved). Fallback
paths rebuild from `finalText` or re-fill the original template bytes.

### 6.2 Registration plan

```
Hand sketch (image)
        │
        ├─► Gemini vision: PLAN_EXTRACTION_SCHEMA  (measurements, not a trace)
        └─► Gemini vision: boundary audit vs form   (concurrent, time-boxed)
                │
                ▼
        planRenderer: reconstruct polygon (north-up, to-scale roads)
                │
                ▼
        SVG data URL ──► client canvas rasterise PNG
                │
                ▼
        export: appendPlanPageToDocx  (+ optional editable DrawingML,
                 optional Aadhaar images page)
```

If vision fails, the endpoint **degrades with a flag** and still renders a plan
from registration-form measurements where possible — never hangs (per-call
timeouts via `PLAN_AI_TIMEOUT_MS`, default 45s).

### 6.3 Gemini resilience

- Primary model: `GEMINI_MODEL` (default `gemini-3.1-flash-lite`)
- Fallback chain: `GEMINI_FALLBACK_MODELS` (default `gemini-3.6-flash,gemini-3.5-flash-lite`)
- Retries on overload (503 / high demand); strips `thinkingConfig` on 400 for
  models that reject it
- Shared classification: `QUOTA_EXHAUSTED` | `NOT_CONFIGURED` | `TIMEOUT` |
  `UNAUTHORIZED` | `BAD_RESPONSE` | `UPSTREAM_ERROR`
- Missing key → heuristic / degraded mode (app stays usable, no fabricated
  “verified” results)

---

## 7. Data & state

| Store | What | Lifetime |
|-------|------|----------|
| React state in `App.tsx` | Full wizard session | Tab session |
| `localStorage["telangana_deeds_registry"]` | Draft registry metadata | Persistent in browser |
| Request JSON | Extraction / verify / export payloads | Per request |
| `./templates/` | Seeded or user-baked `.docx` library | Container disk (ephemeral on free hosts) |
| OS temp | LibreOffice PDF conversion | Deleted after stream |

There is **no server-side session store** and **no multi-tenant auth** in this
version — suitable for demo / trusted local use; production hardening would add
auth, rate limits, and object storage for retained templates.

---

## 8. Formatting contract (deed export)

Enforced in `documentBuilder.ts` regardless of source template formatting when
rebuilding from text:

| Spec | Value |
|------|-------|
| Page | A4 |
| Body font | Times New Roman, 14 pt |
| Page 1 body start | **5.8″** from top (stamp logo / header reserve) |
| Pages 2..n top | 1″ |
| L / R / Bottom | 0.75″ / 0.75″ / 1″ |

In-place fill (`templateFiller`) intentionally **preserves** the uploaded
template’s own formatting by editing run text only.

---

## 9. Frontend architecture notes

- Almost all UI and orchestration live in **`src/App.tsx` (~7,900 lines)** —
  the primary maintainability risk.
- Supporting UI: `DocxLivePreview` (`docx-preview`), `AiStatusBanner`, Tailwind 4.
- Motion (`motion`) and Lucide icons used for step transitions / chrome.
- No router: single-page wizard with step index + flow mode.

**Recommended next refactor** (not yet done): split `src/steps/*`, lift shared
state into a context or store, and code-split step chunks.

---

## 10. Security & ops

| Topic | Status |
|-------|--------|
| Gemini key | Server-only env (`GEMINI_API_KEY`); never shipped to client |
| Secrets in git | `.gitignore` excludes `.env*`; rotate any historically leaked keys |
| Auth / tenancy | None — treat as single-user or behind a trusted edge |
| Uploads | Large base64 bodies; no malware scanning |
| PDF | Requires LibreOffice in image; otherwise fall back to `.docx` + browser print |

See **`DEPLOYMENT.md`** for Render / Cloud Run steps and secret wiring.

---

## 11. Known limitations

1. **Monolithic `App.tsx`** — hard to test and review in isolation.
2. **Ephemeral disk** — uploaded custom templates are not persisted across
   container restarts unless baked into the image or moved to object storage.
3. **Print vs export** — browser Print may not include the plan page the same
   way Word/PDF export does.
4. **Editable DrawingML plan** — optional export path; rendering fidelity across
   Word/LibreOffice not fully verified visually.
5. **No auth / audit trail** — unsuitable for multi-user production without an
   edge auth layer and logging of who exported what.

---

## 12. Recommended target architecture (unchanged direction)

**Demo:** Render Free Docker service (current).  
**Production:** Cloud Run (`asia-south1`) + Secret Manager + Artifact Registry,
same container image. Scale-to-zero; Gemini key injected at runtime.

```
User ──HTTPS──► Cloud Run (this container)
                    │  GEMINI_API_KEY from Secret Manager
                    ▼
               Google Gemini API
```

Config already in-repo: `Dockerfile`, `render.yaml`, `cloudbuild.yaml`,
`.dockerignore`, `.gcloudignore`, `.env.example`.
