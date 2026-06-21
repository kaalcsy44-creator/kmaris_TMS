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
| RFQ detail | `2_CRFQ.py` | Done | Detail shows follow-up level/notes; inline Level update + delete-with-confirm (PUT /rfq/{id}/level, DELETE /rfq/{id}) ported. |
| Customer RFQ registration | `2_CRFQ.py` | Done/Partial | Registration + RFQ PDF OCR + quick Customer/Vessel create (auto-open/prefill from OCR hints) now exist. Remaining: explicit RFQ date/level fields on the new-RFQ form. |
| Vendor RFQ send | `3_VRFQ.py` | Done/Partial | Multi-vendor select, email preview, XLSX quote-sheet download, SMTP send + DB save now exist. Remaining parity: sent-history subview polish and production SMTP verification. |
| Vendor Quote receive | `vendor_quote.py`, `3_VRFQ.py` | Done/Partial | PDF/XLSX response parser upload and item-level quote capture now exist. Remaining parity: richer parser feedback and uploaded-file edge-case verification. |
| Customer Quotation create/send | `4_Quotation.py` | Done | Item/margin editor, PDF download, email preview/send, vendor-quote import selector (cost import + margin), full terms editor, and Proforma Invoice doc-type option now exist. |
| P/O overview table | `5_PO.py` | Done | Checkbox selection, detail panel, tab shell exist. |
| Customer P/O registration | `5_CustomerPO.py` | Partial | Form, quote/RFQ linkage, item editor, order PDF OCR upload exist. Missing quick Customer/Vessel create and status/date edit parity. |
| Vendor P/O workflow | `5b_VendorPO.py` | Done/Partial | Create, email preview, PDF download, SMTP send, sent list exist. Vendor quote price import not fully ported. |
| Documents overview/workflow | `6_Documents.py` | Done | Overview, row selection, milestones, CI/PL/SA/Tax creation, CI/PL/SA PDF download, Tax XLSX download, SA SMTP send, Tax-to-AR creation, CI/PL/SA missing-item validation, and an explicit acknowledgement gate before SA send now exist. Optional: combined CI/PL/SA email package; production SMTP verification → Step 5. |
| AR overview/payment | `7_AR.py` | Done | Overview, status/currency filters, inline payment, manual AR add/edit/delete, and SOA XLSX export (filter-aware, per-currency totals) now exist. Streamlit had no export; this exceeds parity. Remaining: production payment smoke test → Step 5. |
| Settings master data | `8_Settings.py` | Done | Company profile, user list/create/update/delete (self + last-admin guarded) + disable via is_active, own password-change flow, and Customer/Vendor/Vessel/Item Master CRUD now exist. Remaining: production admin permission smoke test → Step 5. |
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

1. ~~Finish remaining RFQ & Quotation polish.~~ **DONE (2026-06-21)**
   - ~~Vendor quote import selector for Customer Quotation.~~
   - ~~PI document option and full terms editor.~~
   - ~~RFQ detail level update/delete + quick Customer/Vessel create.~~
   - Production SMTP/OCR verification → moved to Step 5 smoke checklist.
2. ~~Finish Documents polish.~~ **DONE (2026-06-21)**
   - ~~Stronger missing-item validation before send.~~ SA send now gated on a
     CI-vs-order missing-item check + explicit acknowledgement.
   - Optional combined CI/PL/SA email package — deferred (nice-to-have).
   - Production SMTP smoke test → Step 5.
3. ~~Finish Settings polish.~~ **DONE (2026-06-21)**
   - ~~User delete/disable UX and own password-change flow.~~ DELETE
     /settings/users/{id} (self + last-admin guarded), is_active disable,
     POST /me/password self-service change.
   - Production admin permission smoke test → Step 5.
4. ~~Finish AR polish.~~ **DONE (2026-06-21)**
   - ~~SOA export/reporting.~~ GET /api/admin/ar/soa.xlsx (filter-aware,
     per-currency totals).
   - Production payment/update smoke test → Step 5.
5. Add production smoke checklist.
6. Remove Streamlit files and dependencies.
