from pathlib import Path
from kmaris_docs import load_json, make_pdf, make_tax_invoice_xlsx

BASE = Path(__file__).resolve().parent
company = load_json(BASE / "config" / "company_profile.json")
data = load_json(BASE / "samples" / "sample_data.json")
out = BASE / "samples" / "generated"
out.mkdir(parents=True, exist_ok=True)

for doc_type, suffix in [
    ("quotation", "QTN"),
    ("proforma_invoice", "PI"),
    ("commercial_invoice", "CI"),
    ("packing_list", "PL"),
    ("shipping_advice", "SA"),
]:
    data["doc_no"] = f"KMS-{suffix}-2026-0001"
    pdf = make_pdf(doc_type, data, company=company)
    (out / f"KMS-{suffix}-2026-0001_sample.pdf").write_bytes(pdf)

data["doc_no"] = "KMS-TAX-2026-0001"
xlsx = make_tax_invoice_xlsx(data, company)
(out / "KMS-TAX-2026-0001_sample.xlsx").write_bytes(xlsx)
print(f"Generated sample files in {out}")
