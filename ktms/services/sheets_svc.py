"""Google Sheets sync — mirrors RFQ/Order data for the GAS tracking endpoint.

Setup:
  1. Google Cloud Console → IAM → Service Account → JSON 키 다운로드
  2. 해당 스프레드시트를 서비스 계정 이메일에 '편집자'로 공유
  3. 환경 변수 설정:
       GOOGLE_SHEET_ID     = 스프레드시트 ID (URL의 /d/.../ 부분)
       GOOGLE_SA_KEY_FILE  = 서비스 계정 JSON 키 파일 경로
         또는
       GOOGLE_SA_KEY_JSON  = 서비스 계정 JSON 키 내용 (문자열 전체)
"""
from __future__ import annotations
import json
import logging
import os

log = logging.getLogger(__name__)

try:
    import gspread
    from google.oauth2.service_account import Credentials
    _GSPREAD_OK = True
except ImportError:
    _GSPREAD_OK = False

from services.tracking_status import rfq_tracking_step, order_tracking_step

_SCOPES = [
    "https://spreadsheets.google.com/feeds",
    "https://www.googleapis.com/auth/drive",
]


# ── Internal helpers ──────────────────────────────────────────────────────────

def _client() -> "gspread.Client | None":
    if not _GSPREAD_OK:
        log.warning("sheets_svc: gspread가 설치되지 않음 — 동기화 건너뜀")
        return None

    key_json = os.getenv("GOOGLE_SA_KEY_JSON")
    key_file = os.getenv("GOOGLE_SA_KEY_FILE")

    try:
        if key_json:
            info = json.loads(key_json)
            creds = Credentials.from_service_account_info(info, scopes=_SCOPES)
        elif key_file and os.path.exists(key_file):
            creds = Credentials.from_service_account_file(key_file, scopes=_SCOPES)
        else:
            log.warning("sheets_svc: GOOGLE_SA_KEY_JSON 또는 GOOGLE_SA_KEY_FILE 미설정 — 동기화 건너뜀")
            return None
        return gspread.authorize(creds)
    except Exception as exc:
        log.warning(f"sheets_svc: 인증 실패 — {exc}")
        return None


def _worksheet(sheet_name: str) -> "gspread.Worksheet | None":
    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not sheet_id:
        log.warning("sheets_svc: GOOGLE_SHEET_ID 미설정 — 동기화 건너뜀")
        return None
    gc = _client()
    if gc is None:
        return None
    try:
        return gc.open_by_key(sheet_id).worksheet(sheet_name)
    except Exception as exc:
        log.warning(f"sheets_svc: 시트 '{sheet_name}' 열기 실패 — {exc}")
        return None


def _upsert(ws: "gspread.Worksheet", key_value: str, row_data: list) -> None:
    """A열(col 0)에서 key_value를 찾아 해당 행을 갱신하거나 새 행을 추가."""
    try:
        all_rows = ws.get_all_values()
        for idx, row in enumerate(all_rows):
            if idx == 0:
                continue  # 헤더 행 건너뜀
            if row and str(row[0]).strip().upper() == key_value.upper():
                ws.update(f"A{idx + 1}", [row_data])
                return
        ws.append_row(row_data, value_input_option="USER_ENTERED")
    except Exception as exc:
        log.warning(f"sheets_svc: 행 upsert 실패 ({key_value}) — {exc}")


def _item_summary(items: list) -> str:
    def _desc(it: dict) -> str:
        return it.get("description") or it.get("part_no") or "—"
    if not items:
        return "—"
    if len(items) == 1:
        return _desc(items[0])
    return f"{_desc(items[0])} (+{len(items) - 1} more items)"


# ── Public API ────────────────────────────────────────────────────────────────

def upsert_rfq(rfq, customer, vessel) -> None:
    """RFQ 생성·상태 변경 시 Google Sheet 'RFQ' 시트에 동기화.

    Sheet 컬럼: A=rfq_no B=company C=vessel D=item_summary E=date F=status_key G=status_step H=note
    """
    ws = _worksheet("RFQ")
    if ws is None:
        return

    status_val = rfq.status.value if hasattr(rfq.status, "value") else str(rfq.status)
    step, key = rfq_tracking_step(status_val)

    _upsert(ws, rfq.rfq_no, [
        rfq.rfq_no,
        customer.name if customer else "—",
        vessel.name if vessel else "—",
        _item_summary(rfq.items or []),
        rfq.date or "—",
        key,
        step,
        rfq.notes or "",
    ])
    log.info(f"sheets_svc: RFQ {rfq.rfq_no} 동기화 완료 (step={step}, key={key})")


def upsert_order(order, customer, vessel) -> None:
    """Order 생성·상태 변경 시 Google Sheet 'Orders' 시트에 동기화.

    Sheet 컬럼: A=po_no B=company C=vessel D=item_summary E=date F=status_key G=status_step H=note
    """
    ws = _worksheet("Orders")
    if ws is None:
        return

    status_val = order.status.value if hasattr(order.status, "value") else str(order.status)
    step, key = order_tracking_step(status_val)

    order_ref = order.po_no or f"ORDER-{order.id}"
    _upsert(ws, order_ref, [
        order_ref,
        customer.name if customer else "—",
        vessel.name if vessel else "—",
        _item_summary(order.items or []),
        order.date or "—",
        key,
        step,
        "",
    ])
    log.info(f"sheets_svc: Order {order_ref} 동기화 완료 (step={step}, key={key})")
