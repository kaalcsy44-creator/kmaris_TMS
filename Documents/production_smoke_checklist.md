# KTMS Production Smoke Checklist

Last updated: 2026-06-21

Run this before retiring Streamlit (matrix "Safe Removal Criteria" #4). It verifies
that the Vercel frontend + Render API + Neon DB cover the full RFQ→AR flow.

## 0. Deploy configuration

### Render (backend — `render.yaml`, rootDir `ktms`)
- [ ] Build uses `requirements-api.txt` (includes `pdfplumber`, `anthropic`, `openpyxl`).
- [ ] `startCommand` runs `init_db.py` then `uvicorn admin_api:app`.
- [ ] `healthCheckPath` = `/health` returns 200.
- [ ] Env vars set:
  - [ ] `DATABASE_URL` — Neon connection string (`...?sslmode=require`).
  - [ ] `SECRET_KEY` — generated (JWT signing).
  - [ ] `ADMIN_API_TOKEN` — generated (static bearer fallback).
  - [ ] `ANTHROPIC_API_KEY` — **required for OCR** (`/api/admin/ocr/*`).
  - [ ] `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` — **required for email send**.
  - [ ] `TRACKING_BASE_URL` — optional (defaults to `https://www.k-maris.com/track`).

### Vercel (frontend — `web/`)
- [ ] `NEXT_PUBLIC_API_BASE` = the Render service URL (e.g. `https://ktms-admin-api.onrender.com`).
- [ ] Production build succeeds (`next build`).

## 1. Health + auth
- [ ] `GET /health` → 200.
- [ ] Login at `/login` with a seeded admin → receives JWT, lands on dashboard.
- [ ] An unauthenticated API call returns 401.

## 2. RFQ → AR end-to-end (Vercel UI only — no Streamlit)
- [ ] **Customer RFQ**: create a new RFQ (manual). Optionally upload a PDF and confirm
      OCR fills Customer/Vessel/items (exercises `ANTHROPIC_API_KEY`).
- [ ] **Quick create**: from the new-RFQ form, register a new Customer and Vessel;
      confirm they appear in the dropdowns and auto-select.
- [ ] **Vendor RFQ**: select the RFQ, choose vendor(s), preview email, download the
      quote-sheet XLSX, send (or DB-save if SMTP off).
- [ ] **Vendor Quote**: upload a vendor PDF/XLSX response; confirm item parse; save.
- [ ] **Customer Quotation**: import from the vendor quote (cost + margin), edit terms,
      save; download both Quotation and Proforma Invoice PDFs; send email.
- [ ] **RFQ detail**: change Follow-up level; confirm delete is blocked once a
      Quotation exists.
- [ ] **Customer P/O**: register a P/O linked to the quotation/RFQ (OCR optional).
- [ ] **Vendor P/O**: create, preview, download PDF, send.
- [ ] **Documents**: generate CI → PL → SA → Tax. Confirm missing-item warnings; the
      SA send is blocked until the CI-vs-order check is acknowledged. Download each
      PDF and the Tax XLSX. Confirm Tax creation registers an AR record.
- [ ] **AR**: see the auto-created AR row; record a payment; export the SOA XLSX
      (with and without filters) and confirm per-currency totals.

## 3. Settings / admin
- [ ] Company profile loads and saves.
- [ ] Master data CRUD: Customer / Vendor / Vessel / Item.
- [ ] Users: create, update (incl. disable via `is_active`), delete (confirm self and
      last-active-admin deletion are blocked).
- [ ] Self password change: wrong current password is rejected; correct one succeeds;
      re-login with the new password works.

## 4. Email / OCR production sanity
- [ ] One real outbound email lands (check spam). If `smtp_configured=false` in the UI,
      the SMTP env vars are missing on Render.
- [ ] One real OCR extraction succeeds. A 4xx mentioning `ANTHROPIC_API_KEY` means the
      key is missing on Render.

## 5. Pre-removal gate (matrix "Safe Removal Criteria")
- [ ] RFQ→AR completed above from the Vercel UI only.
- [ ] No endpoint needed by the UI is missing on Render.
- [ ] OCR deps + env vars present in production.
- [ ] Smoke steps 1–4 pass against production URLs.
- [ ] No Streamlit-only import is required by the API runtime (see migration matrix
      "Streamlit app shell" / "PDF/OCR services" rows).
- [ ] Docs / run scripts no longer point operators to Streamlit.

Once every box is checked, proceed with Step 6 (remove Streamlit files + deps).
