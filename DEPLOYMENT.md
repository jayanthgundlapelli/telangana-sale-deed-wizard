# Deployment Guide — Telangana Sale Deed Wizard & Registry

This guide takes you from a working local app to a **free hosted demo** and then
to a **cost-effective production** deployment. It is Google-ecosystem-first
(Gemini API + Cloud Run) with a zero-cost path for development.

**Read `SECURITY` (§0) first — there is a key you must rotate before you push
this repo anywhere.**

---

## 0. ⚠️ SECURITY — do this before pushing to GitHub

During the architecture review a **live Gemini API key** was found committed in
plaintext (in `.env.local` and previously in a project doc):

```
AQ.****REDACTED — the real key was here and has been revoked ****   ← ROTATE THIS
```

This key is now considered **compromised** (it lived in a plaintext file inside a
repo about to be published). Before deploying:

1. Go to **Google AI Studio → API keys** (https://aistudio.google.com/apikey)
   or **Google Cloud Console → Credentials**.
2. **Delete / revoke** the key above and **create a new one**.
3. Put the new key **only** in `.env.local` locally (already git-ignored) and in
   your host's secret store (Render dashboard / GCP Secret Manager) — **never**
   in a committed file.
4. Confirm `git status` does **not** list `.env` or `.env.local`. The repo's
   `.gitignore` already excludes all `.env*` files, but verify before your first
   push.

The app reads the key from `process.env.GEMINI_API_KEY`. If the variable is
absent, the app still runs in a reduced "heuristic" mode (no live AI), so a
missing key degrades gracefully rather than crashing.

---

## 1. Prerequisites

- **Node.js 20+** and npm.
- A **Gemini API key** (see §0). Free-tier keys from Google AI Studio work for
  development; for production, use a key from a billing-enabled Google Cloud
  project so you get higher rate limits.
- For production on Google Cloud: the **`gcloud` CLI** and a Google Cloud project.
- Git + a GitHub account (for the Render path).

Local sanity check before deploying anywhere:

```bash
cp .env.example .env.local          # then paste your NEW key into .env.local
npm ci
npm run build                       # builds SPA + bundles server → dist/
NODE_ENV=production npm start       # boots the production server on :3000
curl -s localhost:3000/api/health   # → {"status":"ok",...}
```

If health returns OK and `curl -s localhost:3000/api/templates` lists templates,
the artifact is deployable.

---

## 2. Environment variables

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `GEMINI_API_KEY` | **Yes** (for live AI) | — | Server-side only. Set via secret store, never committed. Without it the app runs in heuristic mode. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash` | Switch to `gemini-2.5-flash` or `gemini-2.5-flash-lite` to cut cost — see §7. |
| `PORT` | No | `3000` | Hosts (Render, Cloud Run) inject this automatically; the server honors it. |
| `NODE_ENV` | No | — | Set to `production` on all hosts. Enables static-serving mode and skips the Vite dev import. |

`.env.example` in the repo documents these. Copy it to `.env.local` for local dev.

---

## 3. FREE development / demo hosting — Render Free

Best zero-cost path with the fewest steps. The repo already contains
`render.yaml` (a Render Blueprint), so this is nearly one-click.

**Free-tier facts (verify current values at render.com/pricing):**
- Sleeps after **15 min** of inactivity; first request after sleep has a
  **~1 min cold start**. Fine for demos, not for always-on production.
- **750 instance-hours/month** per workspace.
- **Ephemeral filesystem** — anything written at runtime is lost on restart. This
  app is fine with that (templates self-seed on boot; generated files stream to
  the client).
- No server-side LibreOffice → PDF export falls back to `.docx` (see §6).

**Steps:**

1. Push this repo to GitHub (after completing §0).
2. In the **Render dashboard → New → Blueprint**, connect the repo. Render reads
   `render.yaml` and provisions a free Web Service:
   - `buildCommand: npm ci && npm run build`
   - `startCommand: npm start`
   - `healthCheckPath: /api/health`
   - region `singapore` (closest to India; change if you prefer).
3. When prompted, set the **`GEMINI_API_KEY`** environment variable in the
   dashboard (it is marked `sync: false` in the blueprint precisely so it is
   **not** read from the repo). Optionally set `GEMINI_MODEL`.
4. Deploy. Render builds and gives you a `https://<name>.onrender.com` URL.
   `autoDeploy: true` means every push to the default branch redeploys.

> To make Render always-on (no cold starts) later, change `plan: free` to
> `plan: starter` in `render.yaml` (~US$7/mo at time of writing).

**Alternative free option — Railway / Fly.io:** both run the same `Dockerfile`.
Railway gives a monthly usage credit; Fly.io has a small always-on allowance.
Cloud Run (below) is the recommended Google-native free option and doubles as the
production target, so it's usually the better single choice.

---

## 4. PRODUCTION hosting — Google Cloud Run (recommended)

Cloud Run runs the container, **scales to zero** when idle (you pay nothing while
idle), scales up automatically under load, and integrates natively with **Secret
Manager** for the API key. It keeps everything inside Google (Gemini + hosting =
one bill, one IAM model). The repo includes `Dockerfile`, `cloudbuild.yaml`,
`.dockerignore`, and `.gcloudignore` for this.

**Always-free tier (per month, verify at cloud.google.com/run/pricing):**
- **2 million requests**
- **360,000 GB-seconds** of memory
- **180,000 vCPU-seconds** of compute
- Free egress within limits.

For a low-traffic registry tool with scale-to-zero, this typically means
**≈ US$0/month** for hosting; your only real cost is Gemini API usage (§7).

### 4a. One-time project setup

```bash
# Pick your project and region
export PROJECT_ID=your-gcp-project
export REGION=asia-south1                    # Mumbai — lowest latency for India
gcloud config set project $PROJECT_ID

# Enable the APIs used by this deployment
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

# Create the Artifact Registry repo the pipeline pushes to (named "apps")
gcloud artifacts repositories create apps \
  --repository-format=docker --location=$REGION \
  --description="App container images"
```

### 4b. Store the API key in Secret Manager

```bash
# Paste your NEW (rotated) key when prompted; --data-file=- reads stdin
printf '%s' 'YOUR_NEW_GEMINI_KEY' | \
  gcloud secrets create gemini-api-key --data-file=-

# Let Cloud Run's runtime service account read it
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

The key is referenced at deploy time as `gemini-api-key:latest` (see
`cloudbuild.yaml` → `--set-secrets`). To rotate later, add a new secret version
and redeploy — no code or config change needed.

### 4c. Build & deploy

**Option A — one command via Cloud Build (uses `cloudbuild.yaml`):**

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=$REGION,_SERVICE=telangana-sale-deed-wizard,_MODEL=gemini-3.5-flash
```

This builds the image, pushes it to Artifact Registry, and deploys to Cloud Run
with `--min-instances=0 --max-instances=3 --memory=512Mi`, `NODE_ENV=production`,
`GEMINI_MODEL`, and the secret wired in.

**Option B — source deploy (no explicit Docker build):**

```bash
gcloud run deploy telangana-sale-deed-wizard \
  --source . --region $REGION --allow-unauthenticated \
  --port 3000 --memory 512Mi --min-instances 0 --max-instances 3 \
  --set-env-vars NODE_ENV=production,GEMINI_MODEL=gemini-3.5-flash \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

Either way, Cloud Run returns a `https://<service>-<hash>-<region>.run.app` URL.
Verify:

```bash
curl -s https://<your-run-url>/api/health     # → {"status":"ok",...}
```

### 4d. Continuous deployment (optional)

Connect the GitHub repo to a **Cloud Build trigger** on push to `main`, pointing
at `cloudbuild.yaml`. Every merge then builds and deploys automatically — the
production analogue of Render's `autoDeploy`.

---

## 5. Firebase — where it fits

Firebase Hosting is excellent for **static** sites, but this app needs a
**long-running Node server** (Express + Gemini calls + docx generation), so
Firebase Hosting alone isn't enough. Two valid Firebase-flavored options:

- **Firebase Hosting + Cloud Run rewrite** — host the SPA on Firebase's CDN and
  rewrite `/**` (or `/api/**`) to the Cloud Run service above. Nice if you want
  Firebase's CDN/custom-domain workflow, but it's strictly more moving parts than
  Cloud Run serving the SPA itself (which it already does). Only worth it if you
  also use other Firebase products.
- **Cloud Functions / App Hosting** — possible, but Cloud Run (§4) is the more
  natural fit for a containerized always-on-capable server and shares the same
  free tier and Secret Manager integration.

**Recommendation:** use **Cloud Run** as the single origin (it serves both the
SPA and the API). Add Firebase Hosting in front only if you later want its CDN or
are consolidating on Firebase for other reasons.

---

## 6. PDF export in production

Server-side PDF conversion requires **LibreOffice (`soffice`)**, which is **not**
present on Render Free or the base Node image. The app detects its absence and
**falls back to `.docx`** — users get a perfect Word file and can "Print → Save
as PDF" in the browser. No errors, no data loss.

To enable true server-side PDF on Cloud Run, extend the `Dockerfile` to install
LibreOffice:

```dockerfile
# In the runtime stage, before switching to the non-root user:
RUN apk add --no-cache libreoffice ttf-liberation fontconfig
```

This adds ~300–400 MB to the image and needs more memory — bump Cloud Run to
`--memory=1Gi` (or `2Gi`). It still fits comfortably in the free/low-cost tier
for light use, but leave it off unless server PDF is a hard requirement; the
`.docx` + browser-print path covers most needs at zero extra cost.

---

## 7. Cost — comparison & tuning

### Hosting

| Option | Free tier | Cold start | Best for | Est. cost at low traffic |
|--------|-----------|-----------|----------|--------------------------|
| **Render Free** | 750 hrs/mo, sleeps after 15 min | ~1 min | Dev / demo | **$0** |
| **Cloud Run** | 2M req, 360k GB-s, 180k vCPU-s /mo; scales to 0 | ~1–3 s | **Production (recommended)** | **~$0**, cents at low traffic |
| Render Starter | — (always-on) | none | Small always-on prod | ~$7/mo |
| Railway / Fly.io | small monthly credit/allowance | varies | Alt. container host | $0–5/mo |

**Recommendation:** Render Free for development, **Cloud Run for production.**
The dominant variable cost in production is the **Gemini API**, not hosting.

### Gemini model cost (tune via `GEMINI_MODEL`, no code change)

Approximate list prices per 1M tokens (input / output) — **verify current pricing
at ai.google.dev/pricing**, as it changes:

| `GEMINI_MODEL` | Relative cost | When to use |
|----------------|---------------|-------------|
| `gemini-3.5-flash` (default) | Highest of the flash tiers | Best extraction accuracy on messy scans |
| `gemini-2.5-flash` | ~5× cheaper input, ~3–4× cheaper output | Strong accuracy at much lower cost — **good production default** |
| `gemini-2.5-flash-lite` | Cheapest | High volume, simpler/cleaner documents |

**Cost-control levers:**
1. Set `GEMINI_MODEL=gemini-2.5-flash` in production — usually the best
   accuracy-per-rupee. Drop to `-flash-lite` for high volume.
2. Cloud Run `--min-instances=0` (already set) → **no idle hosting cost.**
3. Cap spend with a **Google Cloud budget alert** and, if needed, a per-key
   rate limit in AI Studio.
4. Keep the client bundle and request sizes lean (already gzipped ~259 KB).

---

## 8. Post-deploy checklist

- [ ] Old exposed key **revoked**; new key created and stored in the
      secret store only.
- [ ] `git status` shows **no** `.env*` files tracked.
- [ ] `/api/health` returns `ok` on the deployed URL.
- [ ] `/api/templates` lists the seeded templates.
- [ ] Full 7-step wizard runs end-to-end on the deployed URL.
- [ ] (Production) `GEMINI_MODEL` set to your chosen tier; budget alert enabled.
- [ ] (Optional) CI trigger (Cloud Build / Render autoDeploy) wired to `main`.

---

## 9. File map (deployment-related)

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build → small Node 20 Alpine runtime image (used by Cloud Run/Railway/Fly). |
| `.dockerignore` | Keeps the image build context small and secret-free. |
| `render.yaml` | Render Blueprint for the free dev deploy. |
| `cloudbuild.yaml` | Cloud Build → Cloud Run pipeline for production. |
| `.gcloudignore` | Keeps the Cloud Build upload small and secret-free. |
| `.env.example` | Template for local `.env.local` (never commit the real one). |
| `ARCHITECTURE.md` | The architecture review and rationale behind these choices. |
