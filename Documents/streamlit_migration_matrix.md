# Streamlit to Vercel/Render Migration Matrix

Last updated: 2026-06-21

## Goal

Run KTMS from:

- Frontend: Next.js on Vercel (`web/`)
- Backend: FastAPI on Render (`ktms/admin_api.py`)

Then remove Streamlit-only app code after every operational workflow is covered and verified.

## Status Legend

- Done: implemented in Next.js/FastAPI and locally verified
- Partial: main view exists, but Streamlit behavior is not fully equivalent
- Missing: still Streamlit-only
- Cleanup: not a business feature, but required before removing Streamlit

## Feature Matrix

| Area | Streamlit source | Next/Render status | Notes |
| --- | --- | --- | --- |
| Auth/login | `Home.py`, utils auth | Done | Next login/JWT flow exists. |
| Dashboard | `1_Dashboard.py` | Done | KPI/status overview exists in Next. |
| RFQ overview table | `rfq_quotation.py` | Done | Merged overview table, selection, detail panel exist. |
| RFQ detail | `2_CRFQ.py` | Partial | Detail exists; Streamlit level update/delete not fully ported. |
| Customer RFQ registration | `2_CRFQ.py` | Partial | Basic registration and RFQ PDF OCR upload exist. Quick Customer/Vessel create and full notes/level/date parity still needed. |
| Vendor RFQ send | `3_VRFQ.py` | Done/Partial | Multi-vendor select, email preview, XLSX quote-sheet download, SMTP send + DB save now exist. Remaining parity: sent-history subview polish and production SMTP verification. |
| Vendor Quote receive | `vendor_quote.py`, `3_VRFQ.py` | Done/Partial | PDF/XLSX response parser upload and item-level quote capture now exist. Remaining parity: richer parser feedback and uploaded-file edge-case verification. |
| Customer Quotation create/send | `4_Quotation.py` | Done/Partial | Item/margin editor, PDF download, email preview/send now exist. Remaining parity: vendor quote import selector, PI document option polish, full terms editor. |
| P/O overview table | `5_PO.py` | Done | Checkbox selection, detail panel, tab shell exist. |
| Customer P/O registration | `5_CustomerPO.py` | Partial | Form, quote/RFQ linkage, item editor, order PDF OCR upload exist. Missing quick Customer/Vessel create and status/date edit parity. |
| Vendor P/O workflow | `5b_VendorPO.py` | Done/Partial | Create, email preview, PDF download, SMTP send, sent list exist. Vendor quote price import not fully ported. |
| Documents overview/workflow | `6_Documents.py` | Done/Partial | Overview, row selection, milestones, CI/PL/SA/Tax creation, CI/PL/SA PDF download, Tax XLSX download, SA SMTP send, and Tax-to-AR creation now exist. Remaining parity: production SMTP verification, richer validation, and CI/PL/SA email package polish. |
| AR overview/payment | `7_AR.py` | Done/Partial | Overview, status/currency filters, inline payment, manual AR add, edit, delete now exist. Remaining parity: SOA export/reporting and production payment smoke tests. |
| Settings master data | `8_Settings.py` | Done/Partial | Company profile, user list/create/update, Customer/Vendor/Vessel/Item Master list/create/update/delete now exist. Remaining parity: user delete/own password-change UX and production permission smoke tests. |
| PDF/OCR services | `services/pdf_parser.py` | Partial | RFQ and Order OCR API exists. Need production Render deploy and `ANTHROPIC_API_KEY` verification. |
| PDF document generation | `services/pdf_svc.py`, `kmaris_docs.py` | Done/Partial | Vendor P/O, Quotation, CI, PL, SA PDF APIs and Tax XLSX API exist. Remaining parity: PI option polish and production smoke tests. |
| Email sending | `services/email_svc.py` | Done/Partial | Vendor RFQ, Quotation, Vendor P/O, and SA send APIs exist. Remaining parity: production SMTP verification and combined CI/PL/SA attachment package options. |
| Google Sheets sync | `services/sheets_svc.py` | Missing | Streamlit writes still call sync in some paths; Next/FastAPI equivalents need audit. |
| Streamlit app shell | `ktms/app/**`, `.streamlit` | Cleanup | Remove only after the matrix is all Done or intentionally retired. |
| Dependencies | `requirements.txt`, `requirements-api.txt` | Cleanup | API deps now include OCR deps. Final cleanup should remove Streamlit from production path. |

## Safe Removal Criteria

Do not remove Streamlit until:

1. RFQ to AR end-to-end flow is possible from Vercel UI only.
2. Render exposes every write/send/PDF/OCR endpoint needed by the UI.
3. Production Render deploy includes OCR dependencies and required env vars.
4. Smoke tests pass against production URLs.
5. Streamlit-only imports are not required by API runtime.
6. Docs and run scripts no longer point operators to Streamlit.

## Recommended Implementation Order

1. Finish remaining RFQ & Quotation polish.
   - Vendor quote import selector for Customer Quotation.
   - PI document option and full terms editor.
   - Production SMTP/OCR verification.
2. Finish Documents polish.
   - Production SMTP smoke test.
   - Optional combined CI/PL/SA email package.
   - Stronger missing-item validation before send.
3. Finish Settings polish.
   - User delete/disable UX and own password-change flow.
   - Production admin permission smoke test.
4. Finish AR polish.
   - SOA export/reporting.
   - Production payment/update smoke test.
5. Add production smoke checklist.
6. Remove Streamlit files and dependencies.
