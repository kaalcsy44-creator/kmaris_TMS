"""Document generation — CI, PL, SA, Tax Invoice from an Order."""
from __future__ import annotations
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import (
    inject_css, hint, section_header, next_doc_no, tracking_url,
    order_list, get_order, get_customer, get_vessel, get_ci_for_order,
    missing_items, CURRENCIES, NAVY,
)
from db.engine import get_session
from db.models import Order, CommercialInvoice, PackingList, ShippingAdvice, TaxInvoiceData, ARRecord, ARStatus
from services.pdf_svc import build_payload, generate_pdf, generate_tax_xlsx
from services.email_svc import send_email, shipping_advice_email_body

try:
    st.set_page_config(page_title="문서 생성 — KTMS", page_icon="🗂️", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("documents", "문서 생성 (Documents)")

# ── Order selection ───────────────────────────────────────────────────────────
orders = order_list()
if not orders:
    hint("등록된 오더가 없습니다.")
    st.stop()

order_opts = {o.ord_no: o.id for o in orders}
sel_ord_no = st.selectbox("오더 선택", list(order_opts.keys()))
order = get_order(order_opts[sel_ord_no])

cust   = get_customer(order.customer_id)
vessel = get_vessel(order.vessel_id) if order.vessel_id else None

col_m1, col_m2, col_m3 = st.columns(3)
info_cards = [
    (col_m1, "Customer", cust.name if cust else "—"),
    (col_m2, "선박", vessel.name if vessel else "—"),
    (col_m3, "PO No.", order.po_no or "—"),
]
for col, label, value in info_cards:
    with col:
        st.markdown(f"""
        <div class="ktms-info-card">
            <div class="ktms-info-label">{label}</div>
            <div class="ktms-info-value">{value}</div>
        </div>
        """, unsafe_allow_html=True)

# ── 내부 진행 단계 수동 확인 (자동 추적 안 되는 8·10단계) ────────────────────────
def _set_order_milestone(field: str, value) -> None:
    s = get_session()
    try:
        o = s.query(Order).get(order.id)
        setattr(o, field, value)
        s.commit()
    finally:
        s.close()
    st.rerun()


st.markdown("**내부 진행 단계 확인** — 자동 추적되지 않는 단계를 여기서 처리합니다.")
mc1, mc2 = st.columns(2)
with mc1:
    if order.consignee_confirmed_date:
        st.success(f"✅ 8) Customer 송품처 확인 — {order.consignee_confirmed_date}")
        if st.button("확인 취소", key="undo_consignee"):
            _set_order_milestone("consignee_confirmed_date", None)
    else:
        if st.button("8) Customer 송품처 확인 완료", key="do_consignee", use_container_width=True):
            _set_order_milestone("consignee_confirmed_date", date.today().isoformat())
with mc2:
    if order.vendor_docs_sent_date:
        st.success(f"✅ 10) Vendor 선적서류 발송 — {order.vendor_docs_sent_date}")
        if st.button("발송 취소", key="undo_vdocs"):
            _set_order_milestone("vendor_docs_sent_date", None)
    else:
        if st.button("10) Vendor 선적서류 발송 완료", key="do_vdocs", use_container_width=True):
            _set_order_milestone("vendor_docs_sent_date", date.today().isoformat())


def render_missing_check(doc_items, doc_label: str) -> None:
    """수주 오더 품목 대비 문서 품목 누락 검증 결과를 표시."""
    miss = missing_items(order.items or [], doc_items or [])
    if miss:
        st.error(f"⚠️ {doc_label}에 누락·수량부족 품목 {len(miss)}건 — 발송 전 확인하세요.")
        st.dataframe(
            pd.DataFrame(miss).rename(columns={
                "part_no": "Part No.", "description": "품명",
                "order_qty": "오더 수량", "doc_qty": f"{doc_label} 수량",
            }),
            use_container_width=True, hide_index=True,
        )
    else:
        st.success(f"✅ {doc_label} 품목이 수주 오더와 일치합니다.")


st.markdown("---")

tab_ci, tab_pl, tab_sa, tab_tax = st.tabs(
    ["📄 Commercial Invoice", "📦 Packing List", "🚢 Shipping Advice", "🧾 Tax Invoice Data"]
)

# ══════════════════════════════════════════════════════════════════════════════
# CI
# ══════════════════════════════════════════════════════════════════════════════
with tab_ci:
    existing_ci = get_ci_for_order(order.id)
    st.markdown("**Commercial Invoice** " + (f"— 기존: `{existing_ci.ci_no}`" if existing_ci else "— 미생성"))

    if existing_ci:
        render_missing_check(existing_ci.items, "CI")

    with st.form("ci_form"):
        c1, c2, c3 = st.columns(3)
        ci_date   = c1.date_input("CI 날짜", date.today())
        currency  = c2.selectbox("통화", CURRENCIES)
        vat_rate  = c3.number_input("VAT Rate", 0.0, 1.0, 0.0, 0.01)

        # Items – pre-fill from order, allow edit for weight/hs_code
        seed = existing_ci.items if existing_ci else (order.items or [])
        items_df = st.data_editor(
            pd.DataFrame(seed) if seed else pd.DataFrame(
                columns=["item_no","part_no","description","maker","origin","qty","unit","unit_price","amount","hs_code","remark"]),
            num_rows="dynamic", use_container_width=True, key="ci_items",
        )
        # Shipping info
        st.markdown("**선적 정보**")
        sc1, sc2 = st.columns(2)
        port_loading   = sc1.text_input("Port of Loading", "Busan, Korea")
        port_discharge = sc2.text_input("Port of Discharge", "")
        carrier        = sc1.text_input("Carrier", "TBD")
        bl_awb         = sc2.text_input("B/L or AWB No.", "TBD")
        etd            = sc1.text_input("ETD", "")
        eta            = sc2.text_input("ETA", "")

        save_ci = st.form_submit_button("CI 저장 & PDF 생성", type="primary", use_container_width=True)

    if save_ci:
        items_data = items_df.fillna("").to_dict(orient="records")
        shipping = {
            "port_loading": port_loading, "port_discharge": port_discharge,
            "carrier": carrier, "bl_awb_no": bl_awb, "etd": etd, "eta": eta,
            "shipping_marks": f"K-MARIS / {vessel.name if vessel else ''} / {order.po_no or ''}",
        }
        session = get_session()
        try:
            if existing_ci:
                existing_ci.items = items_data
                existing_ci.shipping = shipping
                existing_ci.currency = currency
                existing_ci.vat_rate = vat_rate
                ci_obj = existing_ci
                session.merge(ci_obj)
            else:
                ci_no = next_doc_no("ci")
                ci_obj = CommercialInvoice(
                    ci_no=ci_no, order_id=order.id,
                    date=ci_date.isoformat(), currency=currency,
                    vat_rate=vat_rate, items=items_data, shipping=shipping,
                    terms=(order_list()[0].items[0] if order.items else {}),
                )
                session.add(ci_obj)
            session.commit()
            # PDF
            payload = build_payload(
                doc_no=ci_obj.ci_no, date=ci_obj.date,
                customer=cust, vessel=vessel,
                items=items_data, terms={},
                currency=currency, vat_rate=vat_rate,
                shipping=shipping, po_no=order.po_no or "",
                export_ref=order.ord_no,
            )
            pdf = generate_pdf("commercial_invoice", payload)
            fname = f"{ci_obj.ci_no}_CI.pdf"
            st.success(f"CI 저장 완료: {ci_obj.ci_no}")
            render_missing_check(items_data, "CI")
            st.download_button("⬇️ CI PDF 다운로드", data=pdf, file_name=fname, mime="application/pdf")
        except Exception as e:
            st.error(f"오류: {e}")
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# PL
# ══════════════════════════════════════════════════════════════════════════════
with tab_pl:
    ci = get_ci_for_order(order.id)
    if not ci:
        st.warning("먼저 Commercial Invoice를 생성하세요.")
    else:
        session = get_session()
        try:
            existing_pl = session.query(PackingList).filter_by(ci_id=ci.id).first()
        finally:
            session.close()

        st.markdown(f"**Packing List** — CI: `{ci.ci_no}`")
        with st.form("pl_form"):
            pl_date = st.date_input("PL 날짜", date.today())
            pl_items = [dict(item) for item in (ci.items or [])]
            for item in pl_items:
                item.setdefault("package", "")
                item.setdefault("net_weight", "")
                item.setdefault("gross_weight", "")
                item.setdefault("dimension", "")
            pl_df = st.data_editor(
                pd.DataFrame(existing_pl.items if existing_pl else pl_items),
                num_rows="dynamic", use_container_width=True, key="pl_items",
            )
            save_pl = st.form_submit_button("PL 저장 & PDF 생성", type="primary", use_container_width=True)

        if save_pl:
            pl_items_data = pl_df.fillna("").to_dict(orient="records")
            session = get_session()
            try:
                if existing_pl:
                    existing_pl.items = pl_items_data
                    session.merge(existing_pl)
                    pl_obj = existing_pl
                else:
                    pl_no = next_doc_no("pl")
                    pl_obj = PackingList(
                        pl_no=pl_no, ci_id=ci.id,
                        date=pl_date.isoformat(), items=pl_items_data,
                    )
                    session.add(pl_obj)
                session.commit()
                payload = build_payload(
                    doc_no=pl_obj.pl_no, date=pl_obj.date,
                    customer=cust, vessel=vessel,
                    items=pl_items_data, terms={},
                    currency=ci.currency, shipping=ci.shipping or {},
                    po_no=order.po_no or "", export_ref=order.ord_no,
                )
                pdf = generate_pdf("packing_list", payload)
                st.success(f"PL 저장 완료: {pl_obj.pl_no}")
                render_missing_check(pl_items_data, "PL")
                st.download_button("⬇️ PL PDF 다운로드", data=pdf,
                                   file_name=f"{pl_obj.pl_no}_PL.pdf", mime="application/pdf")
            except Exception as e:
                st.error(f"오류: {e}")
            finally:
                session.close()

# ══════════════════════════════════════════════════════════════════════════════
# SA
# ══════════════════════════════════════════════════════════════════════════════
with tab_sa:
    ci = get_ci_for_order(order.id)
    st.markdown("**Shipping Advice**")

    with st.form("sa_form"):
        sa_date = st.date_input("SA 날짜", date.today())
        sa_c1, sa_c2 = st.columns(2)
        sa_port_l  = sa_c1.text_input("Port of Loading",    "Busan, Korea")
        sa_port_d  = sa_c2.text_input("Port of Discharge",  "")
        sa_carrier = sa_c1.text_input("Carrier",            "TBD")
        sa_bl      = sa_c2.text_input("B/L or AWB No.",     "TBD")
        sa_etd     = sa_c1.text_input("ETD",                "")
        sa_eta     = sa_c2.text_input("ETA",                "")
        sa_marks   = st.text_input("Shipping Marks",
                                   f"K-MARIS / {vessel.name if vessel else ''} / {order.po_no or ''}")
        to_email_sa = st.text_input("수신자 이메일 (SA 발송용)", cust.email if cust and cust.email else "")
        save_sa = st.form_submit_button("SA 저장 & PDF / 발송", type="primary", use_container_width=True)

    if save_sa:
        sa_shipping = {
            "port_loading": sa_port_l, "port_discharge": sa_port_d,
            "carrier": sa_carrier, "bl_awb_no": sa_bl,
            "etd": sa_etd, "eta": sa_eta, "shipping_marks": sa_marks,
            "po_no": order.po_no or "", "export_ref": order.ord_no,
        }
        sa_no = next_doc_no("sa")
        session = get_session()
        try:
            sa_obj = ShippingAdvice(
                sa_no=sa_no, order_id=order.id,
                date=sa_date.isoformat(), shipping=sa_shipping,
                sent_date=date.today().isoformat(),
            )
            session.add(sa_obj)
            session.commit()
            payload = build_payload(
                doc_no=sa_no, date=sa_date.isoformat(),
                customer=cust, vessel=vessel,
                items=ci.items if ci else (order.items or []),
                terms={}, currency="USD", shipping=sa_shipping,
                po_no=order.po_no or "", export_ref=order.ord_no,
            )
            pdf = generate_pdf("shipping_advice", payload)
            st.success(f"SA 생성 완료: {sa_no}")
            st.download_button("⬇️ SA PDF 다운로드", data=pdf,
                               file_name=f"{sa_no}_SA.pdf", mime="application/pdf")
            t_url = tracking_url("order", order.tracking_token)
            if to_email_sa:
                body = shipping_advice_email_body(cust.name if cust else "Customer", sa_no, t_url)
                ok = send_email(to=to_email_sa, subject=f"[K-MARIS] Shipping Advice {sa_no}",
                                body=body, attachments=[(f"{sa_no}_SA.pdf", pdf)])
                if ok:
                    st.success(f"📧 SA 이메일 발송 → {to_email_sa}")
                else:
                    st.warning("이메일 발송 실패 (SMTP 설정 확인).")
        except Exception as e:
            st.error(f"오류: {e}")
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# TAX INVOICE
# ══════════════════════════════════════════════════════════════════════════════
with tab_tax:
    ci = get_ci_for_order(order.id)
    if not ci:
        st.warning("먼저 Commercial Invoice를 생성하세요.")
    else:
        st.markdown(f"**Tax Invoice Data Sheet** — CI: `{ci.ci_no}`")
        with st.form("tax_form"):
            tax_c1, tax_c2 = st.columns(2)
            tax_date    = tax_c1.date_input("발행일", date.today())
            supply_type = tax_c2.selectbox("공급유형", ["수출(영세율)", "국내 과세(10%)"])
            buyer_biz   = tax_c1.text_input("매입자 사업자번호", cust.tax_id if cust else "")
            tax_vat     = 0.0 if "영세율" in supply_type else 0.1
            save_tax    = st.form_submit_button("Tax Invoice Data XLSX 생성", type="primary")

        if save_tax:
            tax_no = next_doc_no("tax")
            payload = build_payload(
                doc_no=ci.ci_no, date=ci.date,
                customer=cust, vessel=vessel,
                items=ci.items or [], terms={},
                currency="KRW", vat_rate=tax_vat,
                tax_invoice={
                    "issue_date": tax_date.isoformat(),
                    "supply_type": supply_type,
                    "buyer_business_no": buyer_biz,
                },
            )
            try:
                xlsx = generate_tax_xlsx(payload)
                session = get_session()
                try:
                    tax_obj = TaxInvoiceData(
                        tax_no=tax_no, ci_id=ci.id,
                        date=tax_date.isoformat(), items=ci.items or [],
                    )
                    session.add(tax_obj)
                    # Create AR record
                    from app.utils.helpers import total_amount
                    inv_amount = total_amount(ci.items or [])
                    ar = ARRecord(
                        order_id=order.id,
                        ci_no=ci.ci_no,
                        invoice_amount=inv_amount,
                        paid_amount=0.0,
                        currency=ci.currency,
                        status=ARStatus.OUTSTANDING,
                    )
                    session.add(ar)
                    session.commit()
                finally:
                    session.close()
                st.success(f"Tax Invoice Data 생성: {tax_no} | AR 등록 완료")
                st.download_button("⬇️ Tax Invoice XLSX 다운로드", data=xlsx,
                                   file_name=f"{tax_no}_tax_invoice.xlsx",
                                   mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            except Exception as e:
                st.error(f"오류: {e}")
