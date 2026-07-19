# Architecture Review — Telangana Sale Deed Wizard & Registry

_Reviewed as of 2026-07. This document explains how the app is built, the
issues found during an architecture pass, the fixes applied, and the
recommended shape for hosting it cheaply now and in production later._

---

## 1. What the app is

A single-deployable **full-stack TypeScript app**:

- **Frontend** — React 19 + Vite 6 SPA (`src/App.tsx`, Tailwind CSS). A 7-step
  wizard: Registration Form → Review → Select Template → Auto-Fill → Re-Verify →
  Stamp Preview → Download & Print.
- **Backend** — a single **Express** server (`server.ts`) that:
  1. Serves the built SPA (`dist/`) in production, or proxies Vite dev middleware
     in development.
  2. Exposes `/api/*` endpoints that call the **Google Gemini API** server-side
     for document extraction and verification.
  3. Generates Word `.docx` deeds (`documentBuilder.ts`) and manages the deed
     template library (`templateManager.ts`), optionally converting to PDF via
     LibreOffice if present.

There is **no database**. State is the request payload plus a small on-disk
template library that self-seeds on boot. The browser keeps a local registry in
`localStorage`.

```
Browser (React SPA)
   │  HTTPS
   ▼
Express server  ──────────────►  Google Gemini API   (server-side, key hidden)
   ├── serves dist/ (static SPA)
   ├── /api/extract, /api/extract-aadhaar, /api/extract-link-document
   ├── /api/generate-document, /api/fill-template   (docx merge)
   ├── /api/export-document        (docx; optional PDF via LibreOffice)
   ├── /api/verify                 (comprehensive AI audit)
   └── /api/health                 (liveness probe)
        │
        ▼
   ./templates/*.docx   (self-seeding deed template library)
```

### API surface

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/health` | GET | Liveness probe (used by Docker/Render/Cloud Run) |
| `/api/templates` | GET | List deed templates in the library |
| `/api/extract` | POST | Extract structured data from an uploaded deed |
| `/api/extract-aadhaar` | POST | Extract Aadhaar card fields |
| `/api/extract-link-document` | POST | Extract link-document fields |
| `/api/generate-document` | POST | Merge reviewed data into the chosen template |
| `/api/fill-template` | POST | AI-assisted template fill |
| `/api/export-document` | POST | Return `.docx` (and PDF if LibreOffice present) |
| `/api/verify` | POST | Cross-check documents ↔ entered data ↔ final deed |
| `/api/parse-doc` | POST | Parse an uploaded legacy `.doc`/`.docx` |

---

## 2. Architecture strengths (keep these)

- **Single process, single artifact.** One Express server serves both the SPA and
  the API. Trivial to containerize, no CORS, no split origins. Perfect for a
  single small container on any host.
- **Server-side Gemini key.** The API key never reaches the browser — the correct
  pattern. All model calls happen in `server.ts`.
- **Graceful degradation.** If `GEMINI_API_KEY` is missing, the app drops to a
  deterministic "heuristic simulation" mode instead of crashing. If LibreOffice
  is absent, PDF export falls back to `.docx` with a clear message. This makes it
  deployable even on the leanest free tier.
- **Deterministic document core.** `.docx` generation and placeholder merging are
  pure, testable functions independent of the AI layer. Formatting (A4, Times New
  Roman 14pt, 5.8" first-page stamp offset) is enforced in code, not left to the
  template.
- **Stateless request handling.** No sticky sessions or server memory between
  requests → scales horizontally and tolerates scale-to-zero cold starts.

---

## 3. Issues found & fixes applied

| # | Severity | Finding | Fix applied |
|---|----------|---------|-------------|
| 1 | **Critical (security)** | A **live `GEMINI_API_KEY`** was committed in `.env.local`, **and** a second copy sat in `EXTRACTION_SUCCESS.md`. With no `.gitignore`, pushing to GitHub for deployment would leak both. | Added a comprehensive `.gitignore` (ignores all `.env*`), redacted the key in the archived doc, and added `.env.example` as the safe template. **The key in `.env.local` should still be rotated** — see the warning in `DEPLOYMENT.md`. |
| 2 | **High (portability/correctness)** | `server.ts` imported Vite at the **top level**, so the production bundle eagerly `require("vite")` even though Vite is only used for dev HMR. This forced production to install Vite's whole tree, and would crash on boot if anyone trimmed it to devDependencies. | Converted to a **lazy `await import("vite")`** inside the `NODE_ENV !== "production"` branch, and removed `vite` from `dependencies` (kept in `devDependencies`). Verified the built `server.cjs` no longer eagerly requires vite and boots clean under `NODE_ENV=production`. |
| 3 | **High (deploy correctness)** | `vercel.json` modeled the app as a **Vercel serverless function**. This app is a long-running server that seeds files to disk on boot — Vercel's read-only serverless FS and function model don't fit; it would fail or behave unpredictably. | **Removed `vercel.json`.** Recommended hosts are container/long-process platforms (Cloud Run, Render). |
| 4 | **Medium (deploy correctness)** | The `Dockerfile` never copied `templates/`, so user-supplied `.docx` templates would vanish in the image (only runtime self-seeded placeholders would exist). | Rewrote the `Dockerfile` to `COPY templates/`, use `npm ci --omit=dev`, and add a PORT-aware healthcheck. |
| 5 | **Medium (cost)** | The Gemini model (`gemini-3.5-flash`, the priciest flash tier) was hardcoded at 5 call sites. | Extracted to a single **`GEMINI_MODEL` env var** (default `gemini-3.5-flash`). Production can switch to `gemini-2.5-flash` or `-flash-lite` to cut cost with zero code changes. |
| 6 | **Low (config drift)** | `render.yaml` used the deprecated `env: node` key. | Updated to `runtime: node`, pinned `npm ci`, added the `GEMINI_MODEL` var and clarifying comments. |
| 7 | **Low (hygiene)** | ~27 stale AI session-note markdowns + a 202 KB `App.tsx.backup` + obsolete root test scripts cluttered the repo root; browser tab title still read "My Google AI Studio App". | Archived notes to `docs/archive/` (excluded from build context), deleted the backup and dead tests, set the real `<title>`. |
| 8 | **Low (build context)** | `.dockerignore` missed `Samples/`, `.agents/`, screenshots, test files. | Tightened `.dockerignore` and added a matching `.gcloudignore`. |

All fixes verified: `tsc --noEmit` passes, `npm run build` succeeds, and the
production server boots and answers `/api/health` and `/api/templates`.

---

## 4. Known limitations & things to watch

- **Ephemeral filesystem.** The template library and any generated PDF temp dirs
  live on the container's local disk. On Render Free and Cloud Run this disk is
  **ephemeral** — fine here because templates self-seed and generated files are
  streamed straight to the client, nothing needs to persist. If you later let
  users *upload and keep* custom templates, move them to object storage
  (Cloud Storage / S3) or bake them into the image at build time.
- **No PDF engine in most free tiers.** Server-side PDF needs LibreOffice
  (`soffice`), a large binary. It is **not** installed on Render Free or the base
  Node image. The app already degrades to `.docx` + browser "Print → Save as PDF".
  To get true server PDF, use a Docker image with LibreOffice (adds ~400 MB +
  more RAM) — feasible on Cloud Run/Railway, tight on 512 MB free tiers. See
  `DEPLOYMENT.md` §6.
- **`App.tsx` is ~3,800 lines.** It works and is out of scope to refactor now, but
  it's the main future-maintainability risk. When you next touch it, split by
  wizard step into `src/steps/*` and lift shared state into a context/store.
- **Client bundle is ~950 KB** (259 KB gzipped) — acceptable, but code-splitting
  the wizard steps and lazy-loading `motion`/`lucide-react` would cut first paint.
- **In-flight request loss on scale-to-zero.** With `min-instances=0`, a request
  arriving during shutdown could fail; the client already retries/degrades, so
  this is acceptable for this workload.

---

## 5. Recommended target architecture

**For development / demo (free): Render Free Web Service** or **Cloud Run
(scale-to-zero).** Both run the container as-is. Render is the fewest clicks;
Cloud Run keeps you in the Google ecosystem and has a generous always-free tier.

**For production (cost-effective, Google-first): Google Cloud Run + Secret
Manager + Artifact Registry**, region `asia-south1` (Mumbai). Rationale:
- Scales to zero → you pay nothing when idle, cents/month at low traffic.
- Native `--set-secrets` integration keeps `GEMINI_API_KEY` out of the image/env.
- Same container image as dev — no architecture change between environments.
- Stays entirely within Google (Gemini API + Cloud Run) for one bill, one IAM.

Step-by-step for both is in **`DEPLOYMENT.md`**. Config already in the repo:
`Dockerfile`, `render.yaml`, `cloudbuild.yaml`, `.dockerignore`, `.gcloudignore`,
`.env.example`.

```
                 ┌─────────────────────── Google Cloud project ───────────────────────┐
   User ──HTTPS──►  Cloud Run service (this container, scales 0→N)                     │
                 │        │  reads GEMINI_API_KEY at runtime                           │
                 │        ▼                                                            │
                 │   Secret Manager (gemini-api-key)                                   │
                 │   Artifact Registry (container image)  ◄── Cloud Build (cloudbuild.yaml)
                 └──────────────────────────┬──────────────────────────────────────────┘
                                            ▼
                                   Google Gemini API
```
