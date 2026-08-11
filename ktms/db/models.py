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
    address    = Column(String(400))   # 대표 주소(addresses[0] 미러링)
    contact    = Column(String(100))   # 담당자 이름
    contact_phone = Column(String(50)) # 대표 연락처(phones[0] 미러링)
    email      = Column(String(200))   # 대표 이메일(emails[0] 미러링)
    tax_id     = Column(String(100))
    tax_invoice_email = Column(String(200))  # 세금계산서 수신 전용 메일(청구서 Bill to 기본값)
    country    = Column(String(100))   # 대표 지역(regions[0] 미러링)
    # 한 회사가 본사·지사 여러 곳을 두거나 담당자 1명이 이메일·연락처·지역을 여러 개 가질 수
    # 있어 다중값으로 보관. flat 컬럼은 각 리스트의 첫 값(대표)을 미러링해 기존
    # 소비처(PDF·메일·목록)와 호환.
    addresses  = Column(JSON, default=list)
    emails     = Column(JSON, default=list)
    phones     = Column(JSON, default=list)
    regions    = Column(JSON, default=list)
    payment_terms = Column(String(200))  # 기본 결제조건(견적 작성 시 기본값으로 사용)
    logo       = Column(Text)          # 회사 로고 이미지(data URL, 캡쳐 붙여넣기)
    created_at = Column(DateTime, default=datetime.utcnow)


class Vendor(Base):
    __tablename__ = "vendors"
    id             = Column(Integer, primary_key=True)
    name           = Column(String(200), nullable=False)
    address        = Column(String(400))   # 대표 주소(addresses[0] 미러링)
    contact        = Column(String(100))   # 담당자 이름
    contact_phone  = Column(String(50))    # 대표 연락처(phones[0] 미러링)
    email          = Column(String(200))   # 대표 이메일(emails[0] 미러링)
    country        = Column(String(100))   # 대표 지역(regions[0] 미러링)
    addresses      = Column(JSON, default=list)   # 다중 주소(본사·지사, 첫 값=대표)
    emails         = Column(JSON, default=list)   # 다중 이메일(첫 값=대표)
    phones         = Column(JSON, default=list)   # 다중 연락처(첫 값=대표)
    regions        = Column(JSON, default=list)   # 다중 지역(첫 값=대표)
    specialization = Column(String(200))
    payment_terms  = Column(String(200))  # 기본 결제조건(견적 작성 시 기본값으로 사용)
    logo           = Column(Text)          # 회사 로고 이미지(data URL, 캡쳐 붙여넣기)
    created_at     = Column(DateTime, default=datetime.utcnow)


class CustomerContact(Base):
    """고객사 담당자(회사 1 : 담당자 N). 회사의 flat contact/email/phone 은 대표(primary)를 미러링한다."""
    __tablename__ = "customer_contacts"
    id          = Column(Integer, primary_key=True)
    customer_id = Column(Integer, ForeignKey("customers.id"))
    name        = Column(String(100))
    email       = Column(String(200))
    phone       = Column(String(50))
    position    = Column(String(100))   # 직책(예: Purchasing Manager)
    is_primary  = Column(Boolean, default=False)
    created_at  = Column(DateTime, default=datetime.utcnow)


class VendorContact(Base):
    """공급사 담당자(회사 1 : 담당자 N). 회사의 flat contact/email/phone 은 대표(primary)를 미러링한다."""
    __tablename__ = "vendor_contacts"
    id          = Column(Integer, primary_key=True)
    vendor_id   = Column(Integer, ForeignKey("vendors.id"))
    name        = Column(String(100))
    email       = Column(String(200))
    phone       = Column(String(50))
    position    = Column(String(100))
    is_primary  = Column(Boolean, default=False)
    created_at  = Column(DateTime, default=datetime.utcnow)


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

    level: 1=기자재군, 2=기자재, 3=부품 기능.
    (Engine·Deck machinery·… > 4-stroke·Crane·… > Overhaul kit·Seal & gasket·…)
    층마다 축이 하나다 — 업무구분(부품공급/서비스)은 딜의 work_type 이 갖고 있으므로
    여기 넣지 않는다. 넣으면 같은 부품이 두 가지로 갈라져 가격 이력이 쪼개진다.
    기본 트리는 init_db.ITEM_CATEGORY_TREE, 그 뒤 추가는 Settings 에서 코드 수정 없이.
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


class ItemPriceHistory(Base):
    """품목별 구매가(buy)·판매가(sell) 이력. 각 딜 문서의 JSON 라인아이템을
    part_no 로 item_master 에 매칭해 정규화한 파생 테이블(materialized).

    소스 문서를 수정/삭제하면 이 테이블은 즉시 갱신되지 않으므로,
    rebuild_price_history() 로 전체 재구축한다(관리자 Rebuild 버튼/배포 시 백필).
    price_type: 'buy'=공급사 매입(구매가), 'sell'=고객 판매(판매가).
    unit_price·currency 는 소스 통화 그대로 저장하고, 표시 시 환산한다."""
    __tablename__ = "item_price_history"
    id           = Column(Integer, primary_key=True)
    item_id      = Column(Integer, ForeignKey("item_master.id"), index=True, nullable=True)  # NULL=미매칭
    price_type   = Column(String(4), nullable=False)   # 'buy' | 'sell'
    # 소스 문서 식별 (재구축 시 멱등 upsert 키). source_line_idx=문서 내 라인 순번.
    source_type  = Column(String(20), nullable=False)  # vendor_quote|po|quotation|order|ci|ar
    source_id    = Column(Integer, nullable=False)
    source_line_idx = Column(Integer, default=0)
    # 매칭·표시 보조값 (item_id 가 NULL 이어도 목록에 원문을 보여주기 위해 보관)
    part_no      = Column(String(200))
    description  = Column(String(400))
    rfq_id       = Column(Integer, index=True)         # 딜 추적(있으면)
    customer_id  = Column(Integer)
    vendor_id    = Column(Integer)
    vessel_id    = Column(Integer)
    currency     = Column(String(10), default="USD")
    fx_rate      = Column(Float)                        # 소스 문서 환율(1 USD=? KRW), 있으면
    unit_price   = Column(Float, default=0.0)
    qty          = Column(Float, default=0.0)
    amount       = Column(Float, default=0.0)
    doc_date     = Column(String(10))                  # YYYY-MM-DD (거래 기준일)
    created_at   = Column(DateTime, default=datetime.utcnow)


class DocSequence(Base):
    """Monotonically increasing sequence counter per doc_type per year."""
    __tablename__ = "doc_sequences"
    doc_type = Column(String(20), primary_key=True)
    year     = Column(Integer, primary_key=True)
    last_seq = Column(Integer, default=0)


class AppSetting(Base):
    """앱 전역 설정 — key 1개 = JSON 값 1개. 현재 사용처는 회사 프로필("company").

    설정을 파일(config/company.json)에 두면 Render 처럼 배포마다 컨테이너를 새로 만드는
    환경에서 저장한 값이 다음 배포 때 통째로 사라진다(실제로 계좌 정보가 그렇게 날아갔다).
    설정은 DB 에 둔다 — 파일은 최초 1회 씨앗값으로만 읽는다.
    """
    __tablename__ = "app_settings"
    key        = Column(String(64), primary_key=True)
    value      = Column(JSON, default=dict)
    updated_at = Column(DateTime, default=datetime.utcnow)


class EmailTemplate(Base):
    """담당자별(또는 회사 공용) 이메일 초안 템플릿.

    발송 화면의 초안(제목·본문)을 생성할 때 사용한다. 토큰({{rfq_no}} 등) 치환
    방식이며, options 로 ITEM LIST 컬럼 구성을 담는다.
    해석 순서: 개인(user_id=uid) → 회사 기본(user_id=NULL) → 코드 내장 기본값.
    (user_id, doc_type, lang) 조합은 upsert 로직에서 유일하게 유지한다.
    """
    __tablename__ = "email_templates"
    id          = Column(Integer, primary_key=True)
    user_id     = Column(Integer, ForeignKey("users.id"), nullable=True)  # NULL=회사 공용 기본
    doc_type    = Column(String(40), default="vendor_rfq")   # MVP: vendor_rfq
    lang        = Column(String(8), default="en")            # en | ko
    subject_tpl = Column(Text)
    body_tpl    = Column(Text)
    options     = Column(JSON, default=dict)   # {"item_cols": ["part_no","qty","maker","description"]}
    updated_at  = Column(DateTime, default=datetime.utcnow)


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
    # 딜 종결(취소/실주) 사유. 종결 시 저장, 재활성 시 비운다.
    #   code: schedule(일정 지연/취소) | slow_response(대응 지연) | no_quote(견적 불가) | other(기타)
    close_reason      = Column(String(40))   # 사유 코드
    close_reason_note = Column(Text)          # 기타 사유 직접 입력(선택)
    closed_at         = Column(String(16))    # 종결 일시 "YYYY-MM-DDTHH:MM" (KST). 재활성 시 비운다.
    follow_up_level  = Column(SAEnum(FollowUpLevel), default=FollowUpLevel.B)
    request_channel  = Column(String(40))   # 고객 요청 수단: Email/Phone/SMS/WhatsApp/WeChat 등
    items            = Column(JSON, default=list)
    notes            = Column(Text)
    # 내부 12단계 완료 일시(수동 입력/보정값). {"1": "YYYY-MM-DDTHH:MM", ...} (KST 기준).
    # 비어있는 단계는 이벤트 레코드 created_at 에서 자동 동기화해 표시한다.
    stage_dates      = Column(JSON, default=dict)
    # 단계별 코멘트/활동이력. {"1": [{"text": "...", "at": "YYYY-MM-DDTHH:MM"}], ...} (KST).
    stage_notes      = Column(JSON, default=dict)
    # Auto-fill 소스 파일 메타(영구 보관). [{"name","media_type","item_count","at"}]
    source_files     = Column(JSON, default=list)
    tracking_token   = Column(String(64), unique=True, default=lambda: secrets.token_urlsafe(32))
    created_by       = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at       = Column(DateTime, default=datetime.utcnow)


class VendorRFQ(Base):
    __tablename__ = "vendor_rfqs"
    id             = Column(Integer, primary_key=True)
    rfq_id         = Column(Integer, ForeignKey("rfqs.id"))
    vendor_id      = Column(Integer, ForeignKey("vendors.id"))
    # Vendor RFQ별 고유 K-Maris RFQ No.(KMS-RFQ-yymm-nnn). 같은 프로젝트라도 vendor마다 다른 번호.
    kmaris_rfq_no  = Column(String(40))
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
    fx_rate       = Column(Float)                       # 적용 환율(1 USD = ? KRW). 매매기준율/직접입력
    items         = Column(JSON, default=list)
    terms         = Column(JSON, default=dict)  # 거래조건(Incoterms·납기·공급형태 등)
    notes         = Column(Text)
    # Auto-fill 소스 파일 메타(영구 보관). [{"name","media_type","item_count","at"}]
    source_files  = Column(JSON, default=list)
    created_at    = Column(DateTime, default=datetime.utcnow)


class Quotation(Base):
    __tablename__ = "quotations"
    id              = Column(Integer, primary_key=True)
    qtn_no          = Column(String(40), unique=True, nullable=True)   # 수동·선택 입력
    rfq_id          = Column(Integer, ForeignKey("rfqs.id"), nullable=True)
    # 이 견적의 원가(매입) 출처로 선택한 벤더 견적. "Select Vendor quote"에서 고른 값을 저장 —
    # 개요/문서에서 이 견적이 어느 벤더 견적번호에서 나왔는지 잇기 위함. 미선택(수동입력)이면 null.
    vendor_quote_id = Column(Integer, ForeignKey("vendor_quotes.id"), nullable=True)
    customer_id     = Column(Integer, ForeignKey("customers.id"))
    vessel_id       = Column(Integer, ForeignKey("vessels.id"), nullable=True)
    date            = Column(String(10))
    valid_until     = Column(String(10))
    currency        = Column(String(10), default="USD")   # 판매(단가) 통화
    cost_currency   = Column(String(10))                   # 원가(공급사 제시가) 통화
    round_digits    = Column(Integer)                      # 단가 올림 자릿수(ROUNDUP num_digits)
    # Pricing 밴드의 기본 마진(%) — 품목별 margin_pct 와 별개로, 다시 열었을 때 같은
    # 설정으로 이어서 편집하려고 문서에 함께 저장한다(빈 견적·행마다 마진이 다른 견적 대비).
    margin_pct      = Column(Float)
    discount_pct    = Column(Float, default=0.0)            # 총액 할인율(%) — 최종금액 산출용
    fx_rate         = Column(Float)                         # 적용 환율(1 USD = ? KRW). 매매기준율/직접입력
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
    # 수동 완료 표시 {"11":"2026-08-07T15:02", ...} — 고객 P/O(오더) 단위로 기록한다.
    # 한 프로젝트에 P/O가 여러 건이면 A는 결제 완료, B는 아직 미결제일 수 있어서다.
    # NULL 이면 오더별 기록이 생기기 전(구 데이터) — 프로젝트(RFQ.stage_dates) 값을 쓴다.
    stage_dates    = Column(JSON, default=dict)
    status         = Column(SAEnum(OrderStatus), default=OrderStatus.RECEIVED)
    promised_delivery = Column(String(10))   # 약속 납기일 YYYY-MM-DD (납기 준수 측정 기준)
    shipped_date      = Column(String(10))   # 실제 출고일 (출고→송장 Cycle Time 기준)
    delivered_date    = Column(String(10))   # 실제 목적지 인도일 (OTD 측정 기준)
    consignee_confirmed_date = Column(String(10))  # 8) Delivery arrangement - Customer 확인 (수동)
    vendor_docs_sent_date    = Column(String(10))  # 8) Delivery arrangement - Vendor 서류 확인 (수동)
    pod_notes                = Column(Text)        # 8) Delivery Complete · POD 자유 메모
    items          = Column(JSON, default=list)
    terms          = Column(JSON, default=dict)   # 거래조건(Incoterms·Place·결제·포장·보증 등)
    # Auto-fill 소스 파일 메타(영구 보관). [{"name","media_type","item_count","at"}]
    source_files   = Column(JSON, default=list)
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
    currency   = Column(String(10))  # 발주 통화(USD/KRW). 미지정 시 오더/견적 통화 상속
    items      = Column(JSON, default=list)
    terms      = Column(JSON, default=dict)   # 거래조건(Incoterms·Place·결제·포장·보증 등)
    status     = Column(String(40), default="발주완료")
    sent_date  = Column(String(10))
    sent_to_email = Column(String(200))
    # Auto-fill 소스 파일 메타(영구 보관). [{"name","media_type","item_count","at"}]
    source_files = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)


class ProformaInvoice(Base):
    """선적 전 발행하는 견적성 송장(선택). CI 와 독립적으로 오더당 최신 1건을 편집한다."""
    __tablename__ = "proforma_invoices"
    id         = Column(Integer, primary_key=True)
    pi_no      = Column(String(40), unique=True)
    order_id   = Column(Integer, ForeignKey("orders.id"))
    date       = Column(String(10))
    currency   = Column(String(10), default="USD")
    vat_rate   = Column(Float, default=0.0)
    items      = Column(JSON, default=list)
    shipping   = Column(JSON, default=dict)   # 선적정보(port/carrier/etd/eta 등)
    terms      = Column(JSON, default=dict)   # Incoterms·Payment Terms·Freight/Packing/Insurance 등
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
    # 선적정보·Shipping Marks — 비우면 CI 값 상속, 입력하면 PL 값이 우선(_packing_list_payload).
    shipping   = Column(JSON, default=dict)
    packing_info = Column(String)   # 자유 메모(예: "Cartons in 5 pallets")
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
    paid_date      = Column(String(10))   # 완납일 — 수금 등록으로 잔액이 0이 된 날
    status         = Column(SAEnum(ARStatus), default=ARStatus.OUTSTANDING)
    notes          = Column(Text)
    # 세금계산서(대금청구서) 문서 필드 — 9단계 편집창에서 입력, TAX INVOICE PDF 생성에 사용.
    invoice_no     = Column(String(60))    # 송장번호(기본 P/O번호+'-INV')
    invoice_date   = Column(String(10))    # 송장 발행일 YYYY-MM-DD
    vat_rate       = Column(Float, default=0.1)   # 부가세율(내수 기본 10%)
    items          = Column(JSON, default=list)   # 청구 품목(설명·Part No.·수량·단가·금액)
    # 부대비용 {"freight":0,"packing":0,"insurance":0} — 품목 소계에 더해 VAT·합계 계산.
    # (PI/CI 가 terms JSON 에 같은 3개 값을 담는 것과 같은 개념)
    charges        = Column(JSON, default=dict)
    remarks        = Column(Text)          # 청구서 비고(입금 안내 등)
    # 청구처(BILL TO) 오버라이드 — 비우면 고객 마스터값을 사용. 세금계산서 PDF 에 인쇄.
    bill_to_tax_id  = Column(String(60))   # 고객 사업자등록번호
    bill_to_contact = Column(String(100))  # 청구 담당자
    bill_to_email   = Column(String(200))  # 청구 이메일
    bill_to_phone   = Column(String(60))   # 청구 연락처
    created_at     = Column(DateTime, default=datetime.utcnow)


class APRecord(Base):
    """매입 청구(대금청구서·거래명세서) 및 전자세금계산서 수취 기록 — ARRecord 의 매입측 대응.

    한 행 = 하나의 vendor P/O(po_id)에 대한 우리의 지급 의무. 프로젝트 9단계에서 벤더가
    보낸 대금청구서/거래명세서 금액을 확정 입력하고, 10단계에서 전자세금계산서 수취 여부를
    기록한다. Finance 의 지급(payable) 소스로 자동 연결된다(_ap_record_rows)."""
    __tablename__ = "ap_records"
    id             = Column(Integer, primary_key=True)
    po_id          = Column(Integer, ForeignKey("purchase_orders.id"))  # 대응 vendor P/O
    order_id       = Column(Integer, ForeignKey("orders.id"))           # 프로젝트/고객 롤업
    vendor_id      = Column(Integer, ForeignKey("vendors.id"))
    bill_no        = Column(String(60))    # 벤더 대금청구서/거래명세서 번호
    bill_date      = Column(String(10))    # 청구서 발행일 YYYY-MM-DD
    invoice_amount = Column(Float, default=0.0)   # 청구 총액(공급가액+VAT)
    paid_amount    = Column(Float, default=0.0)   # 우리가 지급한 누계
    # 실제 지급일 YYYY-MM-DD — 예정일(due_date)이 아니라 돈이 나간 날. Finance 의
    # '이번 달 실제 지급'·현금흐름 실적이 이 날짜로 회차를 잡는다(없으면 그 달에 못 붙는다).
    paid_date      = Column(String(10))
    currency       = Column(String(10), default="KRW")
    vat_rate       = Column(Float, default=0.1)
    due_date       = Column(String(10))    # 지급 예정일 YYYY-MM-DD
    status         = Column(SAEnum(ARStatus), default=ARStatus.OUTSTANDING)
    items          = Column(JSON, default=list)   # 청구 품목(설명·Part No.·수량·단가·금액)
    charges        = Column(JSON, default=dict)   # 부대비용 {"freight","packing","insurance"}
    # 전자세금계산서 수취(10단계) — vendor P/O 단위라 레코드에 직접 보관.
    tax_received      = Column(Boolean, default=False)  # 전자세금계산서 수취 완료
    tax_received_date = Column(String(10))              # 수취일 YYYY-MM-DD
    tax_invoice_no    = Column(String(60))              # 전자세금계산서 승인번호
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


class FinancePayable(Base):
    """지급대장(회사 지급 예정·이력) — 거래선 지급뿐 아니라 임차료·급여 등 운영비 포함.

    한 행 = 하나의 지급 의무. 반복(recurrence)이 있으면 캘린더·목록에서 기간 내 발생분을
    가상으로 펼쳐 보여주고, 반복 항목의 개별 회차 납부 여부는 paid_dates(JSON 날짜 목록)로
    관리한다. 일회성(recurrence='none') 항목은 paid/paid_date 로 관리한다.
    프로젝트(RFQ) 파이프라인과 무관하게 독립 관리한다(임차료·급여·세금 등)."""
    __tablename__ = "finance_payables"
    id           = Column(Integer, primary_key=True)
    category     = Column(String(40))    # 분류: 거래선지급/임차료/급여/공과금/세금/기타
    counterparty = Column(String(200))   # 거래선·수취인(자유 입력)
    vendor_id    = Column(Integer, ForeignKey("vendors.id"), nullable=True)  # 등록 거래선 연결(선택)
    description  = Column(String(200))   # 내역
    amount       = Column(Float, default=0.0)   # 지급 총액(공급가액 + 부가세)
    # 총액에 포함된 부가세(매입세액). 공급가액 = amount - vat_amount.
    # 결산·부가세 화면의 매입세액 집계에 그대로 쓰인다(면세·급여 등은 0).
    vat_amount   = Column(Float, default=0.0)
    currency     = Column(String(10), default="KRW")
    # 청구서 발행일 YYYY-MM-DD (선택) — 벤더 청구서(APRecord.bill_date)와 같은 뜻.
    # 고지서·계산서를 받은 날. 없으면 빈 값.
    bill_date    = Column(String(10))
    due_date     = Column(String(10))    # 지급 예정일 YYYY-MM-DD (반복이면 최초 회차일)
    recurrence   = Column(String(10), default="none")  # none/monthly/quarterly/yearly
    recur_until  = Column(String(10))    # 반복 종료일(비우면 무기한) YYYY-MM-DD
    paid         = Column(Boolean, default=False)  # 일회성 항목 납부 완료
    paid_date    = Column(String(10))    # 일회성 항목 납부일 YYYY-MM-DD
    paid_dates   = Column(JSON, default=list)  # 반복 항목의 납부 완료 회차일 목록
    # 실제 납부일 — 예정일(회차일)과 다를 수 있어 {회차일: 납부일} 로 따로 보관.
    # (일회성 항목은 paid_date 사용. paid_dates 는 '납부 여부' 판정의 단일 소스로 유지)
    payments     = Column(JSON, default=dict)
    notes        = Column(Text)
    owner_id     = Column(Integer, ForeignKey("users.id"), nullable=True)  # 등록자
    created_at   = Column(DateTime, default=datetime.utcnow)


class FinanceIncome(Base):
    """수입대장(프로젝트 매출 외 기타 수입) — FinancePayable 의 수입측 대응.

    이자·환급·잡수입처럼 고객 청구(ARRecord)와 무관한 입금을 관리한다. 컬럼 구성과
    반복(recurrence)·회차 처리 규칙은 FinancePayable 과 동일해 같은 헬퍼를 함께 쓴다
    (paid=수령 완료, paid_date/payments=실제 입금일)."""
    __tablename__ = "finance_incomes"
    id           = Column(Integer, primary_key=True)
    category     = Column(String(40))    # 분류: 이자수입/환급/잡수입/기타
    counterparty = Column(String(200))   # 지급처(자유 입력)
    customer_id  = Column(Integer, ForeignKey("customers.id"), nullable=True)  # 등록 고객 연결(선택)
    description  = Column(String(200))
    amount       = Column(Float, default=0.0)
    currency     = Column(String(10), default="KRW")
    due_date     = Column(String(10))    # 입금 예정일(반복이면 최초 회차일)
    recurrence   = Column(String(10), default="none")
    recur_until  = Column(String(10))
    paid         = Column(Boolean, default=False)  # 일회성 수령 완료
    paid_date    = Column(String(10))    # 실제 입금일
    paid_dates   = Column(JSON, default=list)  # 반복 항목의 수령 완료 회차일
    payments     = Column(JSON, default=dict)  # {회차일: 실제 입금일}
    notes        = Column(Text)
    owner_id     = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at   = Column(DateTime, default=datetime.utcnow)


class MarketingAsset(Base):
    """홍보 이메일 첨부용 자료 라이브러리(회사소개서·브로슈어 등). DB BLOB 저장
    (Render 파일시스템 휘발 회피 — DeliveryProof 와 동일 방식). 홍보 메일 작성 시
    라이브러리에서 골라 첨부하거나, 작성 화면에서 즉석 업로드도 병행 지원한다."""
    __tablename__ = "marketing_assets"
    id          = Column(Integer, primary_key=True)
    label       = Column(String(200))   # 표시 이름(예: "회사소개서 2026", "Pump Brochure")
    filename    = Column(String(255))    # 원본 파일명(첨부 시 사용)
    mime        = Column(String(120))
    size        = Column(Integer)        # 바이트 크기(목록 표시용)
    data        = Column(LargeBinary)
    owner_id    = Column(Integer, ForeignKey("users.id"), nullable=True)  # 업로더
    created_at  = Column(DateTime, default=datetime.utcnow)


# ── Email history ─────────────────────────────────────────────────────────────

class EmailMessage(Base):
    """회사 메일함에서 가져온 메일 1통 — 프로젝트(RFQ)와 거래처에 연결해 보관한다.

    IMAP 동기화(services/mail_sync.py)가 받은편지함·보낸편지함을 읽어 채운다.
    저장 대상은 Settings 에 등록된 고객·벤더 주소와 오간 메일, 그리고 이미 저장한
    메일의 답장(스레드)뿐이다 — 사내·개인 메일은 아예 들이지 않는다.

    본문은 평문만, 그것도 상한(MAX_BODY_CHARS)까지만 담는다. 첨부는 이름·크기만
    남긴다(원본은 메일함에 있고, DB 전송량은 아껴야 한다)."""
    __tablename__ = "email_messages"
    id          = Column(Integer, primary_key=True)
    # RFC Message-ID — 같은 메일을 두 번 담지 않게 하는 기준이자 스레드의 마디.
    message_id  = Column(String(400), unique=True, index=True)
    in_reply_to = Column(String(400))            # 직전 메일의 Message-ID
    refs        = Column(JSON, default=list)     # References 헤더(스레드 조상 전부)
    thread_key  = Column(String(400), index=True)  # 스레드 뿌리의 Message-ID(없으면 자기 자신)
    direction   = Column(String(3))              # in = 수신, out = 발신
    from_addr   = Column(String(320))
    from_name   = Column(String(200))
    to_addrs    = Column(JSON, default=list)
    cc_addrs    = Column(JSON, default=list)
    subject     = Column(String(500))
    body_text   = Column(Text)                   # 평문 본문(상한까지)
    truncated   = Column(Boolean, default=False)  # 본문을 상한에서 잘랐는지
    attachments = Column(JSON, default=list)     # [{"name": "...", "size": 12345}]
    sent_at     = Column(String(16), index=True)  # "YYYY-MM-DDTHH:MM" (KST)
    # 연결 — 프로젝트(딜)와 상대 거래처. 못 붙인 메일은 rfq_id=NULL 로 '미분류 함'에 남는다.
    rfq_id      = Column(Integer, ForeignKey("rfqs.id"), nullable=True, index=True)
    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=True)
    vendor_id   = Column(Integer, ForeignKey("vendors.id"), nullable=True)
    # 어떻게 붙었는지 — thread | subject | manual. 자동 연결을 사람이 검증할 수 있게 남긴다.
    match_by    = Column(String(20))
    summary     = Column(Text)                   # Claude 한두 줄 요약(없으면 아직 안 만든 것)
    summarized_at = Column(DateTime)
    created_at  = Column(DateTime, default=datetime.utcnow)


class EmailSyncState(Base):
    """IMAP 동기화 진행 표시 — 폴더별로 어디까지 읽었는지.

    UID 는 폴더 안에서만 뜻이 있고 uid_validity 가 바뀌면 전부 무효가 되므로 함께 둔다
    (바뀌면 처음부터 다시 읽되, message_id 유일 제약이 중복 저장을 막는다)."""
    __tablename__ = "email_sync_state"
    folder       = Column(String(200), primary_key=True)
    uid_validity = Column(String(40))
    last_uid     = Column(Integer, default=0)
    last_synced_at = Column(DateTime)
    last_error   = Column(Text)
