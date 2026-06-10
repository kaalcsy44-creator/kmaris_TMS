"""KTMS 내부 상태 → 고객용 추적 단계(k-maris.com/track) 매핑.

sheets_svc(Google Sheet 동기화)와 KTMS Dashboard(직원용 미리보기)가 공유하는
단일 출처(single source of truth). 두 곳의 매핑이 어긋나면 직원이 보는
'고객 추적 단계'와 실제 track.html 표시가 달라지므로 반드시 이 모듈을 통해서만
참조한다.
"""
from __future__ import annotations

# track.html의 steps 배열과 순서/문구가 동일해야 함
RFQ_STEPS = ["RFQ Received", "Preparing Quotation", "Quotation Submitted"]
ORDER_STEPS = ["Order Confirmed", "Under Production", "In Transit", "Delivered"]

# KTMS 내부 상태값(한글) → (step index, status_key)
RFQ_STATUS_MAP: dict[str, tuple[int, str]] = {
    "수신완료":         (0, "received"),
    "공급사 소싱중":     (1, "preparing"),
    "견적 중":          (1, "preparing"),
    "이메일 발송 완료":  (2, "submitted"),
    "수주완료":         (2, "submitted"),
    "실주":            (2, "lost"),
}

ORDER_STATUS_MAP: dict[str, tuple[int, str]] = {
    "오더 수주":         (0, "confirmed"),
    "발주 완료":         (1, "production"),
    "제조/준비중":       (1, "production"),
    "출고완료":          (2, "transit"),
    "운송중":            (2, "transit"),
    "목적지 하차 완료":  (3, "delivered"),
}


def rfq_tracking_step(status: str) -> tuple[int, str]:
    """RFQ 내부 상태 → (step index, status_key). 매핑 없으면 (0, 'received')."""
    return RFQ_STATUS_MAP.get(status, (0, "received"))


def order_tracking_step(status: str) -> tuple[int, str]:
    """Order 내부 상태 → (step index, status_key). 매핑 없으면 (0, 'confirmed')."""
    return ORDER_STATUS_MAP.get(status, (0, "confirmed"))


def rfq_tracking_label(status: str) -> str:
    """RFQ 내부 상태 → 고객 화면에 표시되는 추적 단계 라벨. 예: 'Preparing Quotation (2/3)'."""
    step, _ = rfq_tracking_step(status)
    return f"{RFQ_STEPS[step]} ({step + 1}/{len(RFQ_STEPS)})"


def order_tracking_label(status: str) -> str:
    """Order 내부 상태 → 고객 화면에 표시되는 추적 단계 라벨. 예: 'Under Production (2/4)'."""
    step, _ = order_tracking_step(status)
    return f"{ORDER_STEPS[step]} ({step + 1}/{len(ORDER_STEPS)})"
