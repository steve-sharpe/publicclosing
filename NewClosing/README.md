# Closings TV Dashboard (2025–2026)

A simple TV-ready React app (Vite + Tailwind) that shows home closings for 2025 & 2026 from a Google Sheet or CSV URL.

## Quick start
```bash
npm install
npm run dev
```
Open the local URL printed by Vite.

## Feed it your Google Sheet
1. Create a Sheet with columns (exact headers):  
   `id, job_address, client, community, pm, closing_date, status, notes`  
   - `closing_date` = `YYYY-MM-DD` (e.g., 2025-11-03)
   - `status` in {Scheduled, Delayed, Closed, Cancelled}
2. File → Share → **Publish to web** → Entire document → **CSV** → Publish.
3. Copy the CSV link.
4. In `src/App.tsx`, set `SHEET_CSV_URL` to that link **or** paste the URL in the top-right input at runtime and click **Refresh**.

## TV usage
- Press F11 in your browser for full screen.
- The app auto-rotates through months (configurable in `App.tsx`).

## Customize
- Years shown (`YEARS`), coming-soon window, and auto-rotate speed are at the top of `src/App.tsx`.
- Styling uses Tailwind (see `src/index.css` and `tailwind.config.js`).

## Sample data
There’s a sample `public/closings_template.csv` you can use to test.
