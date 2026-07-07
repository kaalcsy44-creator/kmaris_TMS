from __future__ import annotations
import enum
import secrets
from datetime import datetime
from sqlalchemy import (
    Boolean, Column, DateTime, Enum as SAEnum,
    Float, ForeignKey, Integer, LargeBinary, String, Text,
)
from sqlalchemy.types import JSON
from db.engine import Base


# ── Enumerations ─────────────────────────────────────────────────────────────

class UserRole(str, enum.Enum):
    ADMIN  = "admin"
    SALES  = "sales"
    VIEWER = "viewer"


class WorkType(str, enum.Enum):
    PARTS   = "부품공급"
    SERVICE = "서비스"


class RFQStatus(str, enum.Enum):
    RECEIVED = "수신완료"
    SOURCING = "공급사 소싱중"
    QUOTING  = "견적 중"
    SENT     = "이메일 발송 완료"
    ORDERED  = "수주완료"
    LOST     = "실주"


class QuotationStatus(str, enum.Enum):
    DRAFT       = "초안"
    SENT        = "발송완료"
    NEGOTIATING = "협상중"
    WON         = "수주확정"
    LOST        = "실주"
    EXPIRED     = "만료"


class FollowUpLevel(str, enum.Enum):
    A = "A"
    B = "B"
    C = "C"


class OrderStatus(str, enum.Enum):
    RECEIVED  = "오더 수주"
    PO_SENT   = "발주 완료"
    PREPARING = "제조/준비중"
    SHIPPED   = "출고완료"
    IN_TRANSIT = "운송중"
    DELIVERED = "목적지 하차 완료"


class ARStatus(str, enum.Enum):
    OUTSTANDING = "미수"
    PARTIAL     = "일부수금"
    PAID        = "완납"
    OVERDUE     = "연체"


# ── Master tables ─────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"
    id            = Column(Integer, primary_key=True)
    username      = Column(String(64), unique=True, nullable=False)
    email         = Column(String(128))
    password_hash = Column(String(256), nullable=False)
    role          = Column(SAEnum(UserRole), default=UserRole.SALES)
    is_active     = Column(Boolean, default=True)
    created_at    = Column(DateTime, default=datetime.utcnow)


class RolePermission(Base):
    """역할별 페이지×동작 권한 매트릭스(편집 가능). role=PK, perms=JSON.

    perms 구조: {module: {action: bool}}
      module ∈ dashboard·progress·rfq·po·documents·ar·settings
      action ∈ view·create·edit·delete
    scope: 데이터 범위 "own"(본인 담당만) | "all"(전체).
    admin 역할은 항상 전체 권한이므로 저장/적용 대상에서 제외(코드에서 우회)."""
    __tablename__ = "role_permissions"
    role       = Column(String(32), primary_key=True)
    perms      = Column(JSON, default=dict)
    scope      = Column(String(8), default="all")
    updated_at = Column(DateTime, default=datetime.utcnow)


class Customer(Base):
    __tablename__ = "customers"
    id         = Column(Integer, primary_key=True)
    name       = Column(String(200), nullable=False)
    address    = Column(String(400))
    contact    = Column(String(100))   # 담당자 이름
    contact_phone = Column(String(50)) # 담당자 연락처
    email      = Column(String(200))
    tax_id     = Column(String(100))
    country    = Column(String(100))
    payment_terms = Column(String(200))  # 기본 결제조건(견적 작성 시 기본값으로 사용)
    logo       = Column(Text)          # 회사 로고 이미지(data URL, 캡쳐 붙여넣기)
    created_at = Column(DateTime, default=datetime.utcnow)


class Vendor(Base):
    __tablename__ = "vendors"
    id             = Column(Integer, primary_key=True)
    name           = Column(String(200), nullable=False)
    address        = Column(String(400))
    contact        = Column(String(100))   # 담당자 이름
    contact_phone  = Column(String(50))    # 담당자 연락처
    email          = Column(String(200))
    country        = Column(String(100))
    specialization = Column(String(200))
    payment_terms  = Column(String(200))  # 기본 결제조건(견적 작성 시 기본값으로 사용)
    logo           = Column(Text)          # 회사 로고 이미지(data URL, 캡쳐 붙여넣기)
    created_at     = Column(DateTime, default=datetime.utcnow)


class Vessel(Base):
    __tablename__ = "vessels"
    id          = Column(Integer, primary_key=True)
    name        = Column(String(200), nullable=False)
    imo         = Column(String(20))
    vessel_type = Column(String(60))   # 선박 타입 (Container Ship, Bulk Carrier 등)
    ais_flag    = Column(String(60))   # AIS Flag (기국)
    engine_type = Column(String(200))
    hull_no     = Column(String(100))
    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=True)
    created_at  = Column(DateTime, default=datetime.utcnow)


class ItemCategory(Base):
    """품목 분류(대>중>소) 트리. 자기참조 parent_id 로 계층을 이룬다.

    level: 1=대분류, 2=중분류, 3=소분류. (손그림: 서비스/부품 > 엔진/기타 > 2·4stroke/BWTS…)
    벙커링·선용품 등 신규 분류는 Settings에서 코드 수정 없이 추가한다.
    sort_order 로 형제 노드 표시 순서를 제어(작을수록 먼저)."""
    __tablename__ = "item_categories"
    id         = Column(Integer, primary_key=True)
    parent_id  = Column(Integer, ForeignKey("item_categories.id"), nullable=True)
    level      = Column(Integer, default=1)   # 1=대,2=중,3=소
    name       = Column(String(100), nullable=False)
    sort_order = Column(Integer, default=0)
    active     = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class ItemMaster(Base):
    __tablename__ = "item_master"
    id          = Column(Integer, primary_key=True)
    part_no     = Column(String(100), nullable=False)
    description = Column(String(400))
    maker       = Column(String(200))
    origin      = Column(String(100))
    unit        = Column(String(20), default="PCS")
    hs_code     = Column(String(20))
    std_price   = Column(Float, default=0.0)
    # 분류(가장 깊은 선택 노드). 보통 소분류 id, 소분류 없으면 중분류 id. NULL=미분류.
    category_id = Column(Integer, ForeignKey("item_categories.id"), nullable=True)
    created_at  = Column(DateTime, default=datetime.utcnow)


class DocSequence(Base):
    """Monotonically increasing sequence counter per doc_type per year."""
    __tablename__ = "doc_sequences"
    doc_type = Column(String(20), primary_key=True)
    year     = Column(Integer, primary_key=True)
    last_seq = Column(Integer, default=0)


# ── Trade flow tables ─────────────────────────────────────────────────────────

class RFQ(Base):
    __tablename__ = "rfqs"
    id               = Column(Integer, primary_key=True)
    rfq_no           = Column(String(40), unique=True, nullable=False)  # K-Maris 내부 관리번호 KMS-RFQ-yymm-NNN
    customer_rfq_no  = Column(String(100))   # 고객사 고유 RFQ 번호
    contact_person   = Column(String(100))   # 이 RFQ를 보낸 고객 담당자
    project_title    = Column(String(200))   # 프로젝트 제목(내부 식별용, 선택)
    work_type        = Column(SAEnum(WorkType), default=WorkType.PARTS, nullable=False)  # 업무 타입: 부품공급/서비스
    customer_id      = Column(Integer, ForeignKey("customers.id"))
    vessel_id        = Column(Integer, ForeignKey("vessels.id"), nullable=True)
    date             = Column(String(10))   # YYYY-MM-DD (수신일)
    received_at      = Column(String(16))   # RFQ 수신 일시 "YYYY-MM-DDTHH:MM" (KST)
    status           = Column(SAEnum(RFQStatus), default=RFQStatus.RECEIVED)
    follow_up_level  = Column(SAEnum(FollowUpLevel), default=FollowUpLevel.B)
    request_channel  = Column(String(40))   # 고객 요청 수단: Email/Phone/SMS/WhatsApp/WeChat 등
    items            = Column(JSON, default=list)
    notes            = Column(Text)
    # 내부 12단계 완료 일시(수동 입력/보정값). {"1": "YYYY-MM-DDTHH:MM", ...} (KST 기준).
    # 비어있는 단계는 이벤트 레코드 created_at 에서 자동 동기화해 표시한다.
    stage_dates      = Column(JSON, default=dict)
    # 단계별 코멘트/활동이력. {"1": [{"text": "...", "at": "YYYY-MM-DDTHH:MM"}], ...} (KST).
    stage_notes      = Column(JSON, default=dict)
    tracking_token   = Column(String(64), unique=True, default=lambda: secrets.token_urlsafe(32))
    created_by       = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at       = Column(DateTime, default=datetime.utcnow)


class VendorRFQ(Base):
    __tablename__ = "vendor_rfqs"
    id             = Column(Integer, primary_key=True)
    rfq_id         = Column(Integer, ForeignKey("rfqs.id"))
    vendor_id      = Column(Integer, ForeignKey("vendors.id"))
    sent_date      = Column(String(10))
    sent_at        = Column(String(16))   # 발신 일시 "YYYY-MM-DDTHH:MM" (KST)
    sent_to_email  = Column(String(200))
    status         = Column(String(40), default="발송됨")
    items          = Column(JSON, default=list)
    created_at     = Column(DateTime, default=datetime.utcnow)


class VendorQuote(Base):
    __tablename__ = "vendor_quotes"
    id              = Column(Integer, primary_key=True)
    vendor_rfq_id   = Column(Integer, ForeignKey("vendor_rfqs.id"))
    vendor_quote_no = Column(String(100))   # 수신된 Vendor 고유 견적번호
    received_date   = Column(String(10))
    received_at     = Column(String(16))    # 견적 수신 일시 "YYYY-MM-DDTHH:MM"
    currency      = Column(String(10), default="USD")  # 견적 통화(USD/KRW)
    items         = Column(JSON, default=list)
    terms         = Column(JSON, default=dict)  # 거래조건(Incoterms·납기·공급형태 등)
    notes         = Column(Text)
    created_at    = Column(DateTime, default=datetime.utcnow)


class Quotation(Base):
    __tablename__ = "quotations"
    id              = Column(Integer, primary_key=True)
    qtn_no          = Column(String(40), unique=True, nullable=True)   # 수동·선택 입력
    rfq_id          = Column(Integer, ForeignKey("rfqs.id"), nullable=True)
    customer_id     = Column(Integer, ForeignKey("customers.id"))
    vessel_id       = Column(Integer, ForeignKey("vessels.id"), nullable=True)
    date            = Column(String(10))
    valid_until     = Column(String(10))
    currency        = Column(String(10), default="USD")   # 판매(단가) 통화
    cost_currency   = Column(String(10))                   # 원가(공급사 제시가) 통화
    round_digits    = Column(Integer)                      # 단가 올림 자릿수(ROUNDUP num_digits)
    discount_pct    = Column(Float, default=0.0)            # 총액 할인율(%) — 최종금액 산출용
    vat_rate        = Column(Float, default=0.0)
    items           = Column(JSON, default=list)
    terms           = Column(JSON, default=dict)
    status          = Column(SAEnum(QuotationStatus), default=QuotationStatus.DRAFT)
    follow_up_level = Column(SAEnum(FollowUpLevel), default=FollowUpLevel.B)
    sent_date       = Column(String(10))
    sent_at         = Column(String(16))
    created_by      = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)


class Order(Base):
    __tablename__ = "orders"
    id             = Column(Integer, primary_key=True)
    quotation_id   = Column(Integer, ForeignKey("quotations.id"), nullable=True)
    rfq_id         = Column(Integer, ForeignKey("rfqs.id"), nullable=True)  # 견적 없이 등록 시 RFQ 직접 연결
    customer_id    = Column(Integer, ForeignKey("customers.id"))
    vessel_id      = Column(Integer, ForeignKey("vessels.id"), nullable=True)
    po_no          = Column(String(100))
    date           = Column(String(10))
    currency       = Column(String(10), default="USD")  # 주문 통화(USD/KRW). 미지정 시 연결 견적 통화 사용
    trade_type     = Column(String(10), default="수출", nullable=False)  # 거래구분: 수출/내수(국내공급)
    service_info   = Column(JSON, default=dict)  # 서비스 업무 7~10단계 입력값 {"7":{...},...}
    status         = Column(SAEnum(OrderStatus), default=OrderStatus.RECEIVED)
    promised_delivery = Column(String(10))   # 약속 납기일 YYYY-MM-DD (납기 준수 측정 기준)
    shipped_date      = Column(String(10))   # 실제 출고일 (출고→송장 Cycle Time 기준)
    delivered_date    = Column(String(10))   # 실제 목적지 인도일 (OTD 측정 기준)
    consignee_confirmed_date = Column(String(10))  # 8) Delivery arrangement - Customer 확인 (수동)
    vendor_docs_sent_date    = Column(String(10))  # 8) Delivery arrangement - Vendor 서류 확인 (수동)
    items          = Column(JSON, default=list)
    tracking_token = Column(String(64), unique=True, default=lambda: secrets.token_urlsafe(32))
    created_at     = Column(DateTime, default=datetime.utcnow)


class DeliveryProof(Base):
    """9) 운송 완료 · POD 수취 — 인도 증빙(POD) 파일 1건/오더. DB BLOB 저장(Render 파일시스템 휘발 회피)."""
    __tablename__ = "delivery_proofs"
    id          = Column(Integer, primary_key=True)
    order_id    = Column(Integer, ForeignKey("orders.id"), index=True)
    filename    = Column(String(255))
    mime        = Column(String(120))
    data        = Column(LargeBinary)
    uploaded_at = Column(String(16))   # 업로드 일시 "YYYY-MM-DDTHH:MM" (KST)
    created_at  = Column(DateTime, default=datetime.utcnow)


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"
    id         = Column(Integer, primary_key=True)
    po_no      = Column(String(40), unique=True)
    order_id   = Column(Integer, ForeignKey("orders.id"))
    vendor_id  = Column(Integer, ForeignKey("vendors.id"))
    date       = Column(String(10))
    items      = Column(JSON, default=list)
    status     = Column(String(40), default="발주완료")
    sent_date  = Column(String(10))
    sent_to_email = Column(String(200))
    created_at = Column(DateTime, default=datetime.utcnow)


class CommercialInvoice(Base):
    __tablename__ = "commercial_invoices"
    id         = Column(Integer, primary_key=True)
    ci_no      = Column(String(40), unique=True)
    order_id   = Column(Integer, ForeignKey("orders.id"))
    date       = Column(String(10))
    currency   = Column(String(10), default="USD")
    vat_rate   = Column(Float, default=0.0)
    items      = Column(JSON, default=list)
    shipping   = Column(JSON, default=dict)
    terms      = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)


class PackingList(Base):
    __tablename__ = "packing_lists"
    id         = Column(Integer, primary_key=True)
    pl_no      = Column(String(40), unique=True)
    ci_id      = Column(Integer, ForeignKey("commercial_invoices.id"))
    date       = Column(String(10))
    items      = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)


class ShippingAdvice(Base):
    __tablename__ = "shipping_advices"
    id         = Column(Integer, primary_key=True)
    sa_no      = Column(String(40), unique=True)
    order_id   = Column(Integer, ForeignKey("orders.id"))
    date       = Column(String(10))
    shipping   = Column(JSON, default=dict)
    sent_date  = Column(String(10))
    created_at = Column(DateTime, default=datetime.utcnow)


class TaxInvoiceData(Base):
    __tablename__ = "tax_invoice_data"
    id         = Column(Integer, primary_key=True)
    tax_no     = Column(String(40), unique=True)
    ci_id      = Column(Integer, ForeignKey("commercial_invoices.id"))
    date       = Column(String(10))
    items      = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)


class ARRecord(Base):
    __tablename__ = "ar_records"
    id             = Column(Integer, primary_key=True)
    order_id       = Column(Integer, ForeignKey("orders.id"))
    ci_no          = Column(String(40))
    invoice_amount = Column(Float, default=0.0)
    paid_amount    = Column(Float, default=0.0)
    currency       = Column(String(10), default="USD")
    due_date       = Column(String(10))
    status         = Column(SAEnum(ARStatus), default=ARStatus.OUTSTANDING)
    notes          = Column(Text)
    created_at     = Column(DateTime, default=datetime.utcnow)


class MarketingActivity(Base):
    """잠정(잠재) 고객사 대상 마케팅 활동 기록. RFQ 파이프라인과 무관하게 독립 관리.

    대상은 기존 Customer(customer_id) 연결 또는 미등록 잠정사(prospect_name) 자유입력
    둘 중 하나로 지정한다. 대시보드 마케팅 카드가 최근 활동·후속 예정·월간 집계를 요약한다.
    """
    __tablename__ = "marketing_activities"
    id               = Column(Integer, primary_key=True)
    customer_id      = Column(Integer, ForeignKey("customers.id"), nullable=True)  # 기존 고객사 연결(선택)
    prospect_name    = Column(String(200))   # 미등록 잠정사 자유입력(customer_id 없을 때)
    contact_person   = Column(String(100))   # 고객사 담당자
    recipient_email  = Column(String(200))   # 고객 수신 이메일 주소
    activity_date    = Column(String(10))    # 활동일 YYYY-MM-DD
    channel          = Column(String(40))    # 발송수단: Email/전화/방문/전시회/WhatsApp 등
    activity_type    = Column(String(200))   # 활동유형(복수 선택 가능, ", " 로 join). 예: "Brochure sent, Meeting"
    subject          = Column(String(200))   # 제목·요약
    notes            = Column(Text)          # 상세 내용
    next_action_date = Column(String(10))    # 후속 예정일 YYYY-MM-DD (대시보드 Follow-up)
    owner_id         = Column(Integer, ForeignKey("users.id"), nullable=True)  # 담당자(PIC)
    created_at       = Column(DateTime, default=datetime.utcnow)


class ScheduleEvent(Base):
    """대시보드 Schedule 카드에서 직접 입력·관리하는 일정. 별도 메뉴 없이 카드 내 모달로 등록.

    작성자(owner_id)만(또는 admin) 수정·삭제할 수 있고, 목록은 팀 공용으로 전체 표시한다.
    """
    __tablename__ = "schedule_events"
    id          = Column(Integer, primary_key=True)
    date        = Column(String(10))    # 일정일 YYYY-MM-DD
    title       = Column(String(200))   # 제목
    event_type  = Column(String(40))    # 유형: 미팅/출장/납기/기타 등
    notes       = Column(Text)          # 메모
    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=True)  # 관련 고객사(선택)
    owner_id    = Column(Integer, ForeignKey("users.id"), nullable=True)      # 담당자(PIC)
    created_at  = Column(DateTime, default=datetime.utcnow)
