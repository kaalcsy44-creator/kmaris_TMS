from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List

import pandas as pd
import streamlit as st

from kmaris_docs import (
    DOC_TITLES,
    load_json,
    make_doc_no,
    make_pdf,
    make_tax_invoice_xlsx,
)

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config" / "company_profile.json"
SAMPLE_PATH = BASE_DIR / "samples" / "sample_data.json"

st.set_page_config(
    page_title="K-MARIS Trade Document System",
    page_icon="⚓",
    layout="wide",
)

st.markdown(
    """
    <style>
    .block-container {padding-top: 1.6rem; padding-bottom: 2rem;}
    .kmaris-box {background:#f4f6f8; border:1px solid #d8dee6; border-radius:10px; padding:14px;}
    .small-note {font-size: 0.85rem; color:#4a4f55;}
    </style>
    """,
    unsafe_allow_html=True,
)


def default_company() -> Dict[str, Any]:
    return load_json(CONFIG_PATH)


def default_data() -> Dict[str, Any]:
    data = load_json(SAMPLE_PATH)
    today = date.today()
    data["date"] = today.isoformat()
    data["valid_until"] = (today + timedelta(days=15)).isoformat()
    data["doc_no"] = make_doc_no("quotation", 1)
    return data


def init_state():
    if "company" not in st.session_state:
        st.session_state.company = default_company()
    if "data" not in st.session_state:
        st.session_state.data = default_data()
    if "items_df" not in st.session_state:
        st.session_state.items_df = pd.DataFrame(st.session_state.data["items"])


def text_input_group(prefix: str, fields: List[tuple], obj: Dict[str, Any], cols: int = 2):
    columns = st.columns(cols)
    for idx, (key, label) in enumerate(fields):
        with columns[idx % cols]:
            obj[key] = st.text_input(label, value=str(obj.get(key, "")), key=f"{prefix}_{key}")


def build_payload(doc_type: str) -> Dict[str, Any]:
    d = st.session_state.data
    d["items"] = st.session_state.items_df.fillna("").to_dict(orient="records")
    # Keep doc number aligned with selected document type unless user typed another one.
    return d


init_state()

st.title("K-MARIS Trade Document System")
st.caption("Quotation / Proforma Invoice / Commercial Invoice / Packing List / Shipping Advice / Tax Invoice Data Sheet")

with st.sidebar:
    st.header("Document Control")
    doc_type = st.selectbox(
        "Document Type",
        options=list(DOC_TITLES.keys()) + ["tax_invoice_data"],
        format_func=lambda x: DOC_TITLES.get(x, "TAX INVOICE DATA SHEET"),
    )
    sequence = st.number_input("Sequence No.", min_value=1, max_value=9999, value=1, step=1)
    suggested_no = make_doc_no(doc_type, int(sequence))
    st.session_state.data["doc_no"] = st.text_input("Document No.", value=suggested_no)
    st.session_state.data["date"] = st.date_input("Document Date", value=date.fromisoformat(st.session_state.data.get("date", date.today().isoformat()))).isoformat()
    st.session_state.data["valid_until"] = st.date_input("Quotation Valid Until", value=date.fromisoformat(st.session_state.data.get("valid_until", (date.today()+timedelta(days=15)).isoformat()))).isoformat()
    st.session_state.data["currency"] = st.selectbox("Currency", ["USD", "EUR", "KRW", "SGD", "JPY"], index=["USD", "EUR", "KRW", "SGD", "JPY"].index(st.session_state.data.get("currency", "USD")))
    st.session_state.data["vat_rate"] = st.number_input("VAT Rate", min_value=0.0, max_value=1.0, value=float(st.session_state.data.get("vat_rate", 0.0)), step=0.01, format="%.2f")

    st.divider()
    st.markdown("**Quick Actions**")
    if st.button("Load Sample Data"):
        st.session_state.data = default_data()
        st.session_state.items_df = pd.DataFrame(st.session_state.data["items"])
        st.rerun()
    uploaded_json = st.file_uploader("Import JSON Data", type=["json"])
    if uploaded_json is not None:
        try:
            st.session_state.data = json.load(uploaded_json)
            st.session_state.items_df = pd.DataFrame(st.session_state.data.get("items", []))
            st.success("Imported JSON data.")
        except Exception as exc:
            st.error(f"Import failed: {exc}")

company_tab, business_tab, items_tab, terms_tab, output_tab = st.tabs(
    ["Company", "Customer & Vessel", "Items", "Terms & Shipping", "Generate"]
)

with company_tab:
    st.subheader("Company Profile")
    st.info("초기값은 config/company_profile.json에서 관리합니다. 실제 사업자번호, 주소, 은행 정보를 등기/계좌 개설 후 수정하세요.")
    company_fields = [
        ("company_name_kr", "Korean Company Name"),
        ("company_name_en", "English Company Name"),
        ("address", "Address"),
        ("business_no", "Business Registration No."),
        ("general_email", "General Email"),
        ("sales_email", "Sales Email"),
        ("tax_email", "Tax Email"),
        ("phone", "Phone"),
        ("website", "Website"),
        ("bank_name", "Bank Name"),
        ("bank_account", "Bank Account"),
        ("bank_holder", "Account Holder"),
        ("swift", "SWIFT"),
        ("tagline", "Tagline"),
    ]
    text_input_group("company", company_fields, st.session_state.company, cols=2)

with business_tab:
    st.subheader("Customer / Buyer")
    customer = st.session_state.data.setdefault("customer", {})
    customer_fields = [
        ("name", "Customer Name"),
        ("address", "Customer Address"),
        ("contact", "Contact Person"),
        ("email", "Email"),
        ("tax_id", "Tax ID / Business No."),
    ]
    text_input_group("customer", customer_fields, customer, cols=2)

    st.divider()
    st.subheader("Vessel / Engine")
    vessel = st.session_state.data.setdefault("vessel", {})
    vessel_fields = [
        ("name", "Vessel Name"),
        ("imo", "IMO No."),
        ("engine_type", "Main/Aux Engine Type"),
        ("hull_no", "Hull No."),
    ]
    text_input_group("vessel", vessel_fields, vessel, cols=2)

with items_tab:
    st.subheader("Items")
    st.caption("Part No., Maker, Lead Time, Remark까지 같이 관리하면 선박별/품목별 재견적 속도가 빨라집니다.")
    default_columns = [
        "item_no",
        "part_no",
        "description",
        "maker",
        "origin",
        "qty",
        "unit",
        "unit_price",
        "lead_time",
        "remark",
        "hs_code",
        "package",
        "net_weight",
        "gross_weight",
        "dimension",
    ]
    for col in default_columns:
        if col not in st.session_state.items_df.columns:
            st.session_state.items_df[col] = ""
    st.session_state.items_df = st.data_editor(
        st.session_state.items_df[default_columns],
        num_rows="dynamic",
        use_container_width=True,
        column_config={
            "qty": st.column_config.NumberColumn("qty", min_value=0.0, step=1.0),
            "unit_price": st.column_config.NumberColumn("unit_price", min_value=0.0, step=1.0, format="%.2f"),
        },
    )

with terms_tab:
    st.subheader("Terms")
    terms = st.session_state.data.setdefault("terms", {})
    term_fields = [
        ("incoterms", "Incoterms"),
        ("payment_terms", "Payment Terms"),
        ("delivery_place", "Delivery Place"),
        ("shipment_method", "Shipment Method"),
        ("packing", "Packing"),
        ("warranty", "Warranty"),
    ]
    text_input_group("terms", term_fields, terms, cols=2)
    terms["remarks"] = st.text_area("Remarks", value=terms.get("remarks", ""), height=100)

    st.divider()
    st.subheader("Shipping Information")
    shipping = st.session_state.data.setdefault("shipping", {})
    shipping_fields = [
        ("export_ref", "Export Ref."),
        ("po_no", "Customer PO No."),
        ("port_loading", "Port of Loading"),
        ("port_discharge", "Port of Discharge"),
        ("carrier", "Carrier"),
        ("bl_awb_no", "B/L or AWB No."),
        ("etd", "ETD"),
        ("eta", "ETA"),
        ("shipping_marks", "Shipping Marks"),
    ]
    text_input_group("shipping", shipping_fields, shipping, cols=3)

    st.divider()
    st.subheader("Tax Invoice Data")
    tax = st.session_state.data.setdefault("tax_invoice", {})
    tax_fields = [
        ("issue_date", "Issue Date"),
        ("supply_type", "Supply Type"),
        ("supplier_business_no", "Supplier Business No."),
        ("buyer_business_no", "Buyer Business No."),
    ]
    text_input_group("tax", tax_fields, tax, cols=2)

with output_tab:
    st.subheader("Generate Documents")
    payload = build_payload(doc_type)
    st.markdown(
        "<div class='small-note'>전자세금계산서 실제 발행은 홈택스 또는 인증된 발급대행/ERP에서 세무 검토 후 진행하세요. 이 앱은 초기 MVP 기준으로 PDF와 발행용 데이터 시트를 생성합니다.</div>",
        unsafe_allow_html=True,
    )
    st.divider()
    col1, col2, col3 = st.columns(3)
    with col1:
        if doc_type == "tax_invoice_data":
            xlsx_bytes = make_tax_invoice_xlsx(payload, st.session_state.company)
            st.download_button(
                "Download Tax Invoice Data XLSX",
                data=xlsx_bytes,
                file_name=f"{payload['doc_no']}_tax_invoice_data.xlsx",
                mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        else:
            pdf_bytes = make_pdf(doc_type, payload, company=st.session_state.company)
            st.download_button(
                f"Download {DOC_TITLES[doc_type]} PDF",
                data=pdf_bytes,
                file_name=f"{payload['doc_no']}_{doc_type}.pdf",
                mime="application/pdf",
            )
    with col2:
        json_bytes = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        st.download_button("Export Current Data JSON", data=json_bytes, file_name=f"{payload['doc_no']}_data.json", mime="application/json")
    with col3:
        st.write("Current document:")
        st.code(payload.get("doc_no", ""))

    st.divider()
    st.subheader("Preview Summary")
    st.json({
        "document_no": payload.get("doc_no"),
        "customer": payload.get("customer", {}).get("name"),
        "vessel": payload.get("vessel", {}).get("name"),
        "items": len(payload.get("items", [])),
        "currency": payload.get("currency"),
        "vat_rate": payload.get("vat_rate"),
    })
