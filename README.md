# Telangana Sale Deed Wizard & Registry

An AI-assisted tool for preparing Telangana property **sale deeds**. It guides you
through a 7-step wizard, uses Google Gemini to extract data from uploaded
documents (deeds, Aadhaar, link documents), merges the reviewed data into a
Word template, verifies the result, and produces a print-ready, stamp-formatted
`.docx` (and PDF where a converter is available).

> **Full-stack TypeScript app:** a React 19 + Vite SPA served by a single Express
> server that also exposes the `/api/*` endpoints and calls Gemini server-side
> (the API key never reaches the browser).

## The 7-step wizard

1. **Registration Form** — enter transaction, party, and property details.
2. **Review Details** — a consolidated review sheet of everything extracted/entered.
3. **Select Template** — choose a deed template from the library.
4. **Auto-Fill Draft** — merge reviewed data into the chosen template.
5. **Re-Verify Deed** — comprehensive AI cross-check of documents ↔ data ↔ deed.
6. **Stamp Preview** — A4, Times New Roman 14pt, stamp/header offset preview.
7. **Download & Print** — export `.docx` / PDF and print.

## Run locally

**Prerequisites:** Node.js 20+ and a Gemini API key
([get one free](https://aistudio.google.com/apikey)).

```bash
cp .env.example .env.local     # then paste your Gemini key into .env.local
npm install
npm run dev                    # dev server with Vite HMR
```

Open the URL printed in the terminal. Without a key the app still runs in a
reduced "heuristic" mode (no live AI).

### Production build

```bash
npm run build                  # builds the SPA + bundles the server → dist/
NODE_ENV=production npm start  # serves the built app on :3000
```

## Scripts

| Script | Does |
|--------|------|
| `npm run dev` | Start the Express server with Vite dev middleware (HMR). |
| `npm run build` | Build the SPA and bundle the server to `dist/server.cjs`. |
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

## Tech stack

React 19 · Vite 6 · Tailwind CSS · Express · TypeScript · Google Gemini
(`@google/genai`) · `docx` (Word generation) · `mammoth` / `word-extractor`
(template + document parsing).
# telangana-sale-deed-wizard
