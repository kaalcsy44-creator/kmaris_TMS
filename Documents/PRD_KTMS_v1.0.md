# PRD — K-MARIS Trade Management System (KTMS)
**Product Requirements Document · v1.2 (As-Built) · 2026-06-14**

> **v1.2 변경 요지:** 실제 구현된 `ktms/` 코드베이스와 대조하여 문서를 현행화했습니다.
> Phase 1 전체와 Phase 2 상당 부분이 이미 구현되었으며, 데이터 모델·트래킹 URL·인증
> 방식·역할·통화·문서번호·Follow-up Level 규칙을 실제 구현에 맞게 정정했습니다.
> 각 섹션의 `🟢 구현 / 🟡 부분 / ⚪ 미구현` 마커와 §14 As-Built 요약을 참고하세요.

---

## 0-A. As-Built 구현 현황 요약 (v1.2)

| 모듈 | 구현 위치 | 상태 |
|---|---|---|
| M1 RFQ Management | `app/pages/2_CRFQ.py`(고객RFQ+Vendor RFQ발송), `3_VRFQ.py`(Vendor견적 수신) | 🟢 |
| M2 Quotation | `app/pages/4_Quotation.py` — 마진/통화/Incoterms/PI/이메일 미리보기 | 🟢 |
| M3 Quotation Follow-up | **전용 페이지 없음** — `1_Dashboard.py`에 흡수(Level A·만료임박·연체) + `digest.py` 일일 요약메일 | 🟡 |
| M4 Order Management | `app/pages/5_Orders.py` — 수주+PO 생성, 납기 일정(약속/출고/인도)·OTD | 🟢 |
| M5 Order Preparation | `app/pages/6_Documents.py` — CI/PL/SA/Tax + **누락 품목 검증** | 🟡(납기 D-7/D-3 푸시 알림 미구현) |
| M6 Invoice & AR | `app/pages/7_AR.py` — SOA·수금기록 | 🟡(독촉메일 자동화는 `digest.py` 통합) |
| M7 Tracking Portal | `api.py` (FastAPI, 토큰/번호 조회 read-only) + 외부 k-maris.com | 🟢 |
| 설정/마스터 | `app/pages/8_Settings.py` — 회사/사용자/Customer/Vendor/선박/품목 | 🟢 |

**기술 스택 (실제):** Streamlit(내부앱, 8 페이지) + FastAPI(`api.py`, 트래킹) · SQLAlchemy + SQLite(`data/ktms.db`, `DATABASE_URL`로 PostgreSQL 전환 가능) · 인증 bcrypt + Streamlit `session_state` · PDF ReportLab(`services/kmaris_docs.py`) · Email SMTP(`services/email_svc.py`) · Google Sheets 동기화(`services/sheets_svc.py`).

---

## 0. 제품명 추천

| 후보명 | 약자 | 설명 |
|---|---|---|
| **K-MARIS Trade Management System** | **KTMS** | ✅ 추천. Trade의 견적→수주→배송 전 사이클을 강조 |
| K-MARIS Trade Document System | KTDS | 문서 생성에 국한된 느낌 |
| K-MARIS Order & Quote Platform | KOQP | 직관적이나 브랜드 아이덴티티 약함 |

> **추천 이유:** "TDS(Trade Document System)"는 문서 생성 도구에 머문다는 인상을 주지만, 실제 업무는 RFQ 접수 → 견적 → 수주 → 배송 → AR 회수의 **사이클 전체**를 커버해야 합니다. "Trade Management System"은 동일한 이니셜(KTMS)로 확장성 있는 포지셔닝을 제공합니다.

---

## 1. Executive Summary

K-MARIS Energy & Solutions는 선박 엔진 부품 및 기자재 수출 전문 무역회사입니다. 현재 업무는 이메일·엑셀·PDF를 개별 조합하는 방식으로 수행되어, 견적 추적 누락·문서 재작업·납기 follow-up 지연 등 운영 비효율이 발생합니다.

**KTMS**는 RFQ 접수부터 AR 회수까지 7단계 업무 사이클을 단일 웹 플랫폼으로 통합하고, 고객사에 실시간 추적 포털을 제공하여 투명성을 높이는 SaaS형 무역 관리 시스템입니다.

---

## 2. 배경 및 문제 정의

### 2.1 현행 업무 방식의 Pain Point

| 단계 | 현행 방식 | Pain Point |
|---|---|---|
| RFQ 접수 | 이메일 수동 확인 | 누락·지연 발생, 히스토리 분산 |
| Vendor RFQ | 이메일로 개별 발송 | 공급사 응답 추적 불가 |
| 견적서 작성 | 엑셀 템플릿 수작업 | 마진 계산 오류, 버전 관리 없음 |
| 견적 follow-up | 달력·메모 의존 | 고가 건 누락 리스크 |
| 발주서 생성 | 별도 템플릿 작업 | 견적-발주 데이터 불일치 |
| CI/PL/Tax Invoice | 매번 처음부터 작성 | 품목 오류, 시간 낭비 |
| 배송 추적 | 고객 문의 후 수동 답변 | 고객 경험 저하, CS 부담 |

### 2.2 비즈니스 목표

- 견적 제출 리드타임 **50% 단축**
- 수주 누락 건수 **0건** (follow-up 자동화)
- 고객 CS 문의 **30% 감소** (셀프서비스 트래킹 포털)
- 문서 생성 오류율 **95% 감소** (데이터 자동 연결)

---

## 3. 사용자 및 역할

| 역할 | 설명 | 주요 권한 | As-Built |
|---|---|---|---|
| **Sales (SALES)** | 견적 작성, 수주 관리 전담 | RFQ·견적·오더 전체 CRUD | 🟢 |
| **Admin / Owner (ADMIN)** | 회사 설정, 사용자 관리, AR 관리 | 전체 + 설정 + 사용자 관리 | 🟢 (`is_admin()` 강제: Settings 사용자 관리) |
| **Viewer (VIEWER)** | 발주 현황·배송 현황 열람 | Read-only | 🟡 enum 존재하나 **read-only 미강제** (현재 SALES와 동일 동작). 다중사용자 운영 확정 시 `require_role` 가드 추가 예정 |
| **Customer (외부)** | 자사 RFQ·오더·배송 트래킹 | 본인 건만 열람 (토큰 기반) | 🟢 `api.py` 토큰/문서번호 조회 |
| **Vendor (외부)** | RFQ 수신·견적 제출 | 할당된 RFQ 응답 전용 | ⚪ Vendor 포털 미구현 (현재 Vendor 견적은 내부 `3_VRFQ.py`에서 대리 등록) |

> 인증은 enum `UserRole = ADMIN / SALES / VIEWER` 3종이며, bcrypt 해시 + Streamlit `session_state` 기반(JWT 아님).

---

## 4. 핵심 기능 요구사항

### 4.1 모듈 구조

```
KTMS
├── 1. RFQ Management       — 고객 RFQ 접수 및 Vendor RFQ 발송
├── 2. Quotation            — 우리 견적 작성·PDF 생성·이메일 발송
├── 3. Quotation Follow-up  — 견적 리스트·Level 관리·알림
├── 4. Order Management     — 수주 등록·발주서 생성·발송
├── 5. Order Preparation    — CI/PL 생성·배송 준비·Tax Invoice
├── 6. Invoice & AR         — SOA 관리·미수금 follow-up
└── 7. Tracking Portal      — 고객사 셀프서비스 추적 대시보드
```

---

### 4.2 모듈 1 — RFQ Management

#### 고객 RFQ 접수
- RFQ를 시스템에 등록 (수동 입력 또는 이메일 파싱)
- 필수 필드: RFQ No., 고객사, 선박명/IMO, 품목 리스트(Part No.·수량·납기 희망)
- 자동 상태: `수신완료` → 이후 단계별 상태 전환
- 이메일 알림: 접수 즉시 담당자에게 Slack/Email 알림

#### Vendor RFQ 생성 및 발송
- 고객 RFQ에서 품목 리스트를 자동 가져와 Vendor RFQ 생성
- 복수 Vendor에게 동시 발송 가능 (이메일 연동)
- Vendor별 응답 상태 추적: `발송됨 / 회신 대기 / 회신 완료`
- 문서 번호 체계: `KMS-VRFQ-YYYY-NNNN`

---

### 4.3 모듈 2 — Quotation

#### Vendor 견적 등록 및 자동 연결
- Vendor 견적(가격·납기·비고) 시스템 등록
- 해당 RFQ와 자동 연결, 품목별 Vendor 가격 비교 표 생성
- 복수 Vendor 응답 시 최저가·납기 기준 정렬

#### 우리 견적 작성 (마진·DC 포함)
- Vendor 원가 기반 마진율(%) 입력 → 판매가 자동 계산
- DC(Discount) 항목 지원
- 통화: USD / EUR / KRW / SGD / JPY (환율 수동 입력 또는 API)
- Incoterms 선택: FCA / FOB / CIF / DAP 등
- VAT Rate 설정 (국내 공급 10%, 수출 0%)

#### 견적서(Quotation) PDF 생성
- 문서 번호: `KMS-QTN-YYYY-NNNN`
- 포함 내용: 회사 정보, 고객사, 선박/엔진, 품목 테이블, 합계, 결제조건
- 서명란 포함 (Prepared by / Approved by / Authorized)
- Proforma Invoice 버전 동시 생성 가능: `KMS-PI-YYYY-NNNN`

#### 이메일 발송
- 시스템 내 이메일 작성 및 PDF 첨부 발송 (Gmail API 또는 SMTP)
- 발송 기록 히스토리 저장
- 상태 자동 전환: `이메일 발송 완료`

---

### 4.4 모듈 3 — Quotation Follow-up

#### 견적 리스트 및 Level 관리

| Level | 기준 | 재연락 주기 |
|---|---|---|
| **A** | 금액 USD 50k+ 또는 고객 VIP | 매 3일 |
| **B** | 금액 USD 10k~50k | 매 7일 |
| **C** | 금액 USD 10k 미만 | 매 14일 |

- 담당자가 Level 수동 조정 가능
- 유효기간(Valid Until) 만료 D-3 자동 알림
- 견적 상태: `발송완료 / 협상중 / 수주확정 / 실주 / 만료`
- 필터: 고객사별·선박별·상태별·담당자별

> **As-Built 🟡:** Level은 **금액 기반 자동 분류 미구현** — 현재 담당자가 견적 작성 시 수동 선택(기본 B). 만료 D-3 알림은 대시보드 표시 + `digest.py` 일일 요약메일로 제공(인앱 스케줄러는 없음, Windows 작업 스케줄러/cron로 실행). 자동 Level 규칙(50k/10k 임계)은 향후 `dashboard_stats`/견적 저장 시점에 적용 예정.

---

### 4.5 모듈 4 — Order Management

#### 고객 오더 등록
- 수주 확정 시 해당 견적에서 자동 생성 (중복 입력 없음)
- 고객 PO No. 기재
- 문서 번호: `KMS-ORD-YYYY-NNNN`

#### 발주서(Purchase Order) 생성 및 발송
- 수주 품목에서 자동 생성 → Vendor 발주서 PDF
- 문서 번호: `KMS-PO-YYYY-NNNN`
- Vendor별 분할 발주 지원 (품목이 다수 Vendor에 분산된 경우)
- 발송 후 상태: `발주완료 / 납기확인 대기 / 납기확인완료`

---

### 4.6 모듈 5 — Order Preparation

#### 발주 현황 리스트 및 Follow-up
- 발주일·예상 납기일·현재 상태 테이블 뷰
- 예상 납기 D-7, D-3 알림
- 상태: `발주완료 / 제조중 / 출고준비 / 출고완료 / 입고완료`

#### Commercial Invoice (CI) 생성
- 문서 번호: `KMS-CI-YYYY-NNNN`
- 수주 오더에서 품목 자동 가져오기
- HS Code, 원산지, Gross/Net Weight, Dimension 입력
- PDF 생성 (A4 Landscape, K-MARIS 브랜딩)

#### Packing List (PL) 생성
- 문서 번호: `KMS-PL-YYYY-NNNN`
- CI와 연동 (품목 자동 동기화)
- Package 번호, 치수, 중량 입력
- CI와 함께 묶음 PDF 생성 가능

#### Tax Invoice Data Sheet 생성
- CI/PL 연계 자동 생성
- 홈택스 입력용 데이터 시트 (XLSX)
- 공급유형 선택: 수출(영세율) / 국내 과세
- 실제 전자세금계산서 발행은 홈택스 별도 진행

#### Shipping Advice 생성
- 문서 번호: `KMS-SA-YYYY-NNNN`
- B/L or AWB No., ETD/ETA, 운송사 정보 입력
- 고객사 이메일 자동 발송 연동

---

### 4.7 모듈 6 — Invoice & AR

#### Missing 품목 재점검 🟢
- CI/PL 발송 전 수주 품목 대비 누락 품목 자동 검증 — `helpers.missing_items()` (Part No. 기준 수량 대조)
- 불일치 항목 하이라이트 표시 — `6_Documents.py` CI/PL 탭에서 저장 시 및 기존 CI 조회 시 경고 표

#### SOA (Statement of Account) 관리
- 고객사별 미수금 현황 대시보드
- 인보이스 발행일·결제 기한·수금 현황
- 결제 기한 D-7, D-3, 초과 시 자동 알림
- 상태: `미수 / 일부수금 / 완납 / 연체`

#### AR Follow-up
- Level별 follow-up 주기 설정 (A/B/C)
- 수금 기록 등록 (날짜·금액·수단)

---

### 4.8 모듈 7 — Tracking Portal (고객사 대시보드)

> **통합 전략:** 트래킹 포털은 독립 앱이 아니라, 자사 홈페이지 **www.k-maris.com** 의 확장 서비스로 제공됩니다. 고객은 홈페이지에서 버튼 클릭 한 번으로 본인의 RFQ·오더 현황을 확인합니다.

---

#### 7-1. www.k-maris.com 연동 — 진입 버튼 배치

고객이 자연스럽게 트래킹으로 유입될 수 있도록 홈페이지 내 3개 지점에 진입점을 배치합니다.

**① 상단 네비게이션 바 (Global Nav)**

```
[About]  [Services]  [Supply]  [Contact]  |  [Send RFQ]  [Track ▾]
                                                                    ↓
                                                 ┌─────────────────────┐
                                                 │  Track your RFQ     │
                                                 │  Track your Order   │
                                                 └─────────────────────┘
```

- 현재 네비게이션(About / Services / Supply / Contact) 우측 끝에 `Track` 드롭다운 추가
- 드롭다운 항목: **"Track your RFQ"** / **"Track your Order"**
- 스타일: `Send RFQ` 버튼과 동일 계열이지만 Outline 스타일로 구분 (채워진 버튼 vs 테두리 버튼)

**② 히어로 섹션 (Homepage)**

```
┌────────────────────────────────────────────────────────────────┐
│  "Marine Professional-Led Solutions"                           │
│  Integrated Marine Supply, Bunkering & Technical Services      │
│                                                                │
│  [Send RFQ]  [Our Services]  |  [Track RFQ]  [Track Order]    │
│  ← 기존 Primary CTAs →          ← 신규 Secondary CTAs →        │
└────────────────────────────────────────────────────────────────┘
```

- 기존 CTA(`Send RFQ`, `Our Services`) 옆에 Secondary 스타일로 추가
- 텍스트: `Track your RFQ` / `Track your Order`
- 기존 고객이 직관적으로 자신의 진행 상황을 확인할 수 있는 진입점 역할

**③ Services 페이지 — "From RFQ to Delivery" 섹션**

홈페이지 Services 페이지에 이미 존재하는 **"From RFQ to Delivery"** 워크플로우 다이어그램 하단에 연동 배너 추가:

```
┌──────────────────────────────────────────────────────────────┐
│  Already placed an order?                                    │
│  Track your shipment status in real time.                    │
│  [Track your RFQ →]          [Track your Order →]           │
└──────────────────────────────────────────────────────────────┘
```

---

#### 7-2. 트래킹 포털 접근 방식

| 항목 | 내용 | As-Built |
|---|---|---|
| **진입 URL** | `www.k-maris.com/track/...` (홈페이지 측 페이지) | 🟢 외부 웹 |
| **KTMS API 계약** | `GET /api/track?type=rfq&token={token}` 또는 `?type=order&no={doc_no}` (FastAPI, `api.py`) | 🟢 |
| **인증 방식** | 토큰 기반 (로그인 불필요) — 이메일 링크의 `tracking_token`, 또는 문서번호 검색 | 🟢 |
| **응답** | RFQ/Order 단계·품목요약(가격/벤더 비공개)·상태. Order는 SA 선적정보(B/L·운송사·POL/POD·ETD/ETA) 포함 | 🟢 (선적정보 v1.2 추가) |
| **CORS** | `k-maris.com`, `*.vercel.app`, localhost 허용 (GET 전용) | 🟢 |
| **토큰 유효기간** | RFQ: 90일 / Order: 완료 후 180일 | ⚪ 만료 미적용(토큰 영구) — 향후 적용 |
| **브랜딩** | k-maris.com 동일 헤더·푸터 (외부 웹에서 처리) | 🟢 |

> **As-Built 정정:** 경로형 `/track/rfq/{token}`이 아니라 **쿼리 파라미터형 API**(`/api/track?type=&token=` / `&no=`)입니다. 홈페이지가 이 API를 호출해 렌더링합니다. 토큰 만료(90/180일)는 아직 미적용.

토큰은 다음 시점에 이메일로 자동 발송됩니다:
- RFQ 수신 확인 메일 → RFQ 트래킹 링크 포함
- 견적서 발송 메일 → 동일 RFQ 트래킹 링크 포함
- 수주 확인 메일 → Order 트래킹 링크로 업그레이드
- SA(Shipping Advice) 발송 메일 → Order 트래킹 링크 포함

---

#### 7-3. RFQ 추적 타임라인

```
●──────────●──────────●──────────●──────────○
수신완료    공급사       견적 중     이메일       완료
           소싱중                  발송완료
May 28     May 29     May 30     Jun 02      진행중
```

- 완료된 단계: 채워진 원(●), 진행 중: 애니메이션 점멸, 미도달: 빈 원(○)
- 각 단계 클릭 시 상세 메모 (예: "MAN B&W 공급사 3개사 소싱 중") 표시
- 담당자 이름·연락처 표시

---

#### 7-4. 오더 추적 타임라인

```
●──────────●──────────●──────────◑──────────○──────────○
오더 수주   발주 완료   제조/준비중  출고완료    운송중     목적지
                                                         하차완료
Jun 03     Jun 04     Jun 05      Jun 10     진행중
```

- 선적 정보 카드: B/L No., 운송사, Port of Loading, Port of Discharge, ETD/ETA
- 예상 도착일 하이라이트 표시

---

#### 7-5. 트래킹 포털 페이지 레이아웃

```
┌─────────────────────────────────────────────────────────────┐
│  [K-MARIS Logo]  About  Services  Supply  Contact  Track ▾  │  ← k-maris.com 동일 헤더
├─────────────────────────────────────────────────────────────┤
│  ░░░░░ NAVY HERO BANNER ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│  Shipment Tracking  |  MV OCEAN STAR  |  KMS-ORD-2026-0001 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  [타임라인 스텝퍼]                                            │
│  ●──────●──────●──────◑──────○──────○                       │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────────────────┐ │
│  │  Shipment Info   │  │  Documents                       │ │
│  │  B/L: TBD        │  │  📄 Commercial Invoice  [Download]│ │
│  │  Carrier: TBD    │  │  📦 Packing List        [Download]│ │
│  │  ETD: Jun 10     │  │  📋 Shipping Advice     [Download]│ │
│  │  ETA: Jun 15     │  └──────────────────────────────────┘ │
│  └──────────────────┘                                        │
│                                                              │
│  [Need help? Contact us →  sales@k-maris.com]               │
├─────────────────────────────────────────────────────────────┤
│  [K-MARIS Footer]  Engineering Reliability. Supplying...   │  ← k-maris.com 동일 푸터
└─────────────────────────────────────────────────────────────┘
```

---

#### 7-6. 고객사 알림 이메일 트래킹 링크 형식

```
Subject: [K-MARIS] Your RFQ KMS-CRFQ-2026-0001 has been received

Dear Mr. John Lee,

We have received your RFQ for MV OCEAN STAR.
Track the progress of your request here:

  → Track your RFQ: https://www.k-maris.com/track/rfq/abc123xyz...

Our team will revert with a quotation within 2 business days.

Best regards,
K-MARIS Energy & Solutions
```

---

## 5. 데이터 모델 (핵심 엔티티)

```
Customer
  └── RFQ (1:N)              [rfq_no, status, follow_up_level, items(JSON), tracking_token]
        ├── VendorRFQ (1:N)
        │     └── VendorQuote (1:N)
        └── Quotation (1:N, rfq_id nullable)   ← RFQ 없이도 견적 생성 가능
              └── Order (1:N, quotation_id nullable)   ← 견적 없이도 오더 가능(orphan order)
                    ├── PurchaseOrder (1:N, per vendor)
                    ├── CommercialInvoice (1:N)
                    │     ├── PackingList (1:1)
                    │     └── TaxInvoiceData (1:1)
                    ├── ShippingAdvice (1:N, 최신본 사용)
                    └── ARRecord (1:N)

Vendor (M:N with RFQ via VendorRFQ)
Vessel (customer_id 보유 — Customer와 1:N)
ItemMaster (part_no, description, maker, origin, std_price — Master DB)
```

> **As-Built 정정:** `Quotation.rfq_id`, `Order.quotation_id`는 **nullable**이라 PRD v1.1의 강결합(1:1)이 아닌 **선택적 연결(optional 1:N)**입니다. 대시보드는 "RFQ 연결 없는 Order"를 별도 표시합니다.
> **Order 신규 필드(v1.2):** `promised_delivery`(약속 납기일), `shipped_date`(실제 출고일), `delivered_date`(실제 인도일) — OTD·출고→송장 Cycle Time 측정 및 트래킹 포털 ETA 표시용. 상태가 `출고완료`/`목적지 하차 완료`로 바뀌면 출고일·인도일이 자동 기록됩니다.

---

## 6. 문서 번호 체계

| 문서 | 약자 | 번호 형식 | 예시 |
|---|---|---|---|
| Customer RFQ | CRFQ | KMS-CRFQ-YYYY-NNNN | KMS-CRFQ-2026-0001 |
| Vendor RFQ | VRFQ | KMS-VRFQ-YYYY-NNNN | KMS-VRFQ-2026-0001 |
| Quotation | QTN | KMS-QTN-YYYY-NNNN | KMS-QTN-2026-0001 |
| Proforma Invoice | PI | KMS-PI-YYYY-NNNN | KMS-PI-2026-0001 |
| Order | ORD | KMS-ORD-YYYY-NNNN | KMS-ORD-2026-0001 |
| Purchase Order | PO | KMS-PO-YYYY-NNNN | KMS-PO-2026-0001 |
| Commercial Invoice | CI | KMS-CI-YYYY-NNNN | KMS-CI-2026-0001 |
| Packing List | PL | KMS-PL-YYYY-NNNN | KMS-PL-2026-0001 |
| Shipping Advice | SA | KMS-SA-YYYY-NNNN | KMS-SA-2026-0001 |
| Tax Invoice Data | TAX | KMS-TAX-YYYY-NNNN | KMS-TAX-2026-0001 |

---

## 7. UI/UX 설계 방향

> **설계 원칙:** KTMS는 두 개의 UI 레이어를 가집니다.
> - **내부 관리 도구 (KTMS App):** K-MARIS 직원 전용, Navy/Blue 컬러 시스템
> - **고객 대면 트래킹 포털:** www.k-maris.com 브랜드 완전 통일, 고객 신뢰감 최우선

---

### 7.1 디자인 시스템

#### A. KTMS 내부 앱 — 기존 `kmaris_docs.py` 팔레트 계승

| 토큰 | HEX | 용도 |
|---|---|---|
| `NAVY` | `#0B1D3A` | 헤더 배경, 사이드바, 테이블 헤더 |
| `BLUE` | `#0055A8` | 주요 액션 버튼, 섹션 구분선, 링크 |
| `LIGHT_BLUE` | `#EAF3FF` | 카드 배경, 선택된 행 하이라이트 |
| `LIGHT_GRAY` | `#F4F6F8` | 폼 배경, 라벨 셀, 짝수 행 |
| `MID_GRAY` | `#D8DEE6` | 테이블 보더, 구분선, 비활성 상태 |
| `DARK_GRAY` | `#3A3F44` | 본문 텍스트, 부제목 |

#### B. 트래킹 포털 — www.k-maris.com 브랜드 통일

| 요소 | 홈페이지 참조 | 트래킹 포털 적용 |
|---|---|---|
| 헤더/네비게이션 | k-maris.com 상단 바 그대로 | 동일한 Nav 컴포넌트 공유 |
| 로고 | `kmaris_logo_transparent.png` | 동일 로고 파일 사용 |
| 푸터 | 네이비 배경 + 화이트 로고 + 태그라인 | 동일 Footer 컴포넌트 공유 |
| Primary 버튼 | "Send RFQ" 스타일 (채워진 버튼) | 동일 스타일 유지 |
| Secondary 버튼 | "Our Services" 스타일 (Outline) | Track 버튼에 적용 |
| 히어로 배너 색상 | 네이비 다크 배경 (#0B1D3A 계열) | 트래킹 페이지 상단 배너에 적용 |
| 태그라인 | "Engineering Reliability. Supplying Performance." | 푸터에 동일 표시 |

**구현 방식:** 트래킹 포털은 k-maris.com의 헤더/푸터 컴포넌트를 import하거나, 동일 HTML/CSS를 복제하여 브랜드 일관성을 유지합니다. 고객이 트래킹 페이지를 방문할 때 "다른 서비스로 이동한" 느낌 없이 자연스러운 경험을 제공합니다.

---

### 7.2 KTMS 내부 앱 레이아웃

```
┌─────────────────────────────────────────────────────┐
│  [⚓ K-MARIS KTMS]  [RFQ] [Quote] [Order]           │  ← Top Nav (NAVY #0B1D3A)
│                     [Prep] [AR] [Tracking Settings] │
├──────────┬──────────────────────────────────────────┤
│          │  Dashboard                                │
│  Side    │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  Nav /   │  │ Open RFQ │ │ Active   │ │ AR O/S   │ │
│  Filter  │  │    12    │ │ Orders 7 │ │  $42k    │ │
│          │  └──────────┘ └──────────┘ └──────────┘ │
│          │                                          │
│          │  [Urgent Follow-up]  [Activity Feed]     │
└──────────┴──────────────────────────────────────────┘
```

#### 주요 페이지 레이아웃

**Dashboard**
- KPI 카드 (상단 4개): Open RFQ / Active Orders / AR Outstanding / 이번 달 견적 발송
- 긴급 Follow-up 리스트: Level A 만료 임박 견적, 연체 AR
- 최근 활동 피드: 상태 변경 타임라인 (모든 모듈 통합)
- 배송 현황 맵 (Phase 3): 운항 중 선박 위치

**RFQ 리스트**
```
┌─────┬─────────────┬──────────────┬───────┬────────┬────────┬──────────┐
│ No. │ Customer    │ Vessel       │ Items │  금액  │ Status │  Action  │
├─────┼─────────────┼──────────────┼───────┼────────┼────────┼──────────┤
│0001 │ ABC Ship... │ MV OCEAN...  │   3   │$12,4k  │ 견적중  │  [열기]  │
└─────┴─────────────┴──────────────┴───────┴────────┴────────┴──────────┘
```

**견적 상세 — Stepper UI**
```
  [1 RFQ 정보] → [2 Vendor RFQ] → [3 Vendor 견적] → [4 우리 견적] → [5 발송]
       ●               ●                ●                 ◑               ○
    완료             완료             완료             작성중          대기
```

---

### 7.3 트래킹 포털 — www.k-maris.com 통합 레이아웃

트래킹 포털 페이지는 k-maris.com의 헤더와 푸터를 그대로 사용하고, 중간 콘텐츠 영역만 KTMS에서 동적으로 렌더링합니다.

```
┌──────────────────────────────────────────────────────────────────┐
│  [K-MARIS Logo]  About  Services  Supply  Contact  [Track ▾]    │  ← k-maris.com 헤더
├──────────────────────────────────────────────────────────────────┤
│  ░░░░░░░░░░ NAVY HERO BANNER (#0B1D3A) ░░░░░░░░░░░░░░░░░░░░░░   │
│  Shipment Tracking                                               │
│  MV OCEAN STAR  ·  KMS-ORD-2026-0001  ·  ABC Ship Management   │
├──────────────────────────────────────────────────────────────────┤
│  (흰 배경 콘텐츠 영역)                                             │
│                                                                  │
│  Current Status: 출고완료 — Your shipment is on the way          │
│                                                                  │
│  ●──────────●──────────●──────────●──────────○──────────○       │
│  RFQ수신    견적발송    수주완료    출고완료    운송중      도착     │
│  Jun 03     Jun 05     Jun 10     Jun 15     진행중               │
│                                                                  │
│  ┌───────────────────────┐  ┌───────────────────────────────┐   │
│  │  Shipment Details     │  │  Documents                    │   │
│  │  B/L No.:    TBD      │  │  Commercial Invoice  [↓ PDF] │   │
│  │  Carrier:    TBD      │  │  Packing List        [↓ PDF] │   │
│  │  Loading:    Busan    │  │  Shipping Advice     [↓ PDF] │   │
│  │  Discharge:  SGP      │  └───────────────────────────────┘   │
│  │  ETD:        Jun 15   │                                       │
│  │  ETA:        Jun 20   │                                       │
│  └───────────────────────┘                                       │
│                                                                  │
│  Questions? Contact us: sales@k-maris.com                        │
├──────────────────────────────────────────────────────────────────┤
│  [K-MARIS Footer]  Engineering Reliability. Supplying...        │  ← k-maris.com 푸터
└──────────────────────────────────────────────────────────────────┘
```

---

## 8. 이메일 연동

| 시나리오 | 트리거 | 수신자 | 첨부 | As-Built |
|---|---|---|---|---|
| Vendor RFQ 발송 | Vendor RFQ 생성 | Vendor 이메일 | Vendor RFQ(XLSX) | 🟢 `2_CRFQ.py` |
| 견적서 발송 | 견적 발송 버튼 | 고객사 이메일 | Quotation/PI PDF | 🟢 `4_Quotation.py` (EN/KR 본문·미리보기) |
| 발주서 발송 | PO 생성 | Vendor 이메일 | PO PDF | ⚪ PO 자동 메일 미구현(PDF 생성만) |
| 선적 안내 | SA 생성 | 고객사 이메일 | SA PDF (+추적링크) | 🟢 `6_Documents.py` |
| Follow-up 리마인더 | 스케줄(일1회) | 담당자 이메일 | 견적/AR 요약(본문) | 🟡 `digest.py` — 외부 스케줄러로 실행 |
| 결제 독촉 | AR 연체 | 담당자 | 연체 AR 요약 | 🟡 `digest.py`에 통합(고객 직접 독촉은 미구현) |

> **As-Built:** 인앱 스케줄러(APScheduler 등)는 없습니다. Follow-up/연체 요약은 `digest.py`를 Windows 작업 스케줄러/cron으로 주기 실행해 담당자에게 발송합니다.

---

## 9. 개발 Phase 로드맵

### Phase 1 — MVP ✅ 완료
> 기존 Streamlit MVP를 확장하는 방향

- [x] 고객/공급사/선박/품목 **Master DB** (SQLite, `DATABASE_URL`로 PostgreSQL 전환 가능)
- [x] RFQ 등록 및 상태 관리
- [x] 견적서 생성 (`services/kmaris_docs.py` 재사용) + 마진 계산(품목별 margin_pct 지원)
- [x] CI / PL / SA / Tax Invoice Data Sheet 연동 생성
- [x] 기본 이메일 발송 (SMTP)
- [x] 로그인·역할 관리 (Admin / Sales / Viewer)

**기술 스택 (실제 구현):**
```
Backend  : Python — Streamlit(내부앱) + FastAPI(api.py, 트래킹)
DB       : SQLite (data/ktms.db), PostgreSQL 전환 가능 (SQLAlchemy)
Auth     : bcrypt + Streamlit session_state  (JWT 미사용)
PDF      : ReportLab (services/kmaris_docs.py)
Email    : smtplib (services/email_svc.py)
Sheets   : Google Sheets 동기화 (services/sheets_svc.py)
Frontend : Streamlit (8 페이지)
```

### Phase 2 — 운영 강화 (진행 중)
- [~] Follow-up Level 관리 + 알림 — 🟡 수동 Level + 대시보드/`digest.py` 알림 (금액 자동분류·인앱 스케줄러 미구현)
- [x] AR / SOA 대시보드 (`7_AR.py`)
- [~] **고객 트래킹 포털 — www.k-maris.com 연동**
  - [x] 토큰/문서번호 기반 트래킹 API (`api.py` — 쿼리형 `/api/track`)
  - [x] 이메일 발송 시 트래킹 링크 자동 포함 (견적·SA)
  - [x] Order 응답에 SA 선적정보(B/L·운송사·ETD/ETA) 포함 (v1.2)
  - [ ] 토큰 만료(90/180일) 적용
  - 홈페이지 측 Nav `Track ▾`·히어로 CTA·배너는 외부 웹 담당(§13)
- [ ] Vendor Portal (Vendor 직접 견적 제출) — 현재 내부 대리 등록(`3_VRFQ.py`)
- [x] Google Sheets 문서/상태 동기화 (`services/sheets_svc.py`)
- [~] 발주 현황 대시보드 — 🟡 대시보드에 발주 대기 카드, 전용 뷰는 미구현

### Phase 2.5 — v1.2 추가 (완료)
- [x] Order 납기 필드(약속/출고/인도) + OTD 표시, 출고·인도 자동 기록
- [x] CI/PL **누락 품목 자동 검증** (`helpers.missing_items`)
- [x] 일일 Follow-up/연체 **요약 이메일** (`digest.py`)
- [x] 공유 상수(`CURRENCIES`) 통합 — 통화 목록 페이지 간 불일치(JPY) 해소
- [x] 대시보드 핵심 성과 KPI(Handling Rate·TAT·Hit Rate·Gross Margin) + 파이프라인 알림 칩
- [x] `init_db.py` 컬럼 마이그레이션 유틸(`migrate_columns`) + `get_engine` 버그 수정

### Phase 3 — 고도화 (예정)
- [ ] 품목 Master DB 가격 히스토리 (Vendor별 단가 이력)
- [ ] 환율 자동 조회 API 연동
- [ ] 배송 추적 API 연동 (Sea-rates / Marine Traffic)
- [ ] 모바일 최적화 (고객 포털)
- [ ] 전자세금계산서 API 연동 (KCB/이세로 등)
- [ ] 보고서 자동 생성 (월별 수출실적, AR 현황)
- [ ] **OTD / Invoice Cycle Time KPI 대시보드 노출** (v1.2에서 데이터 필드 확보, 카드화 예정)
- [ ] Follow-up Level **금액 자동 분류**(A=50k+/B=10–50k/C<10k) 적용

---

## 10. 비기능 요구사항

| 항목 | 요구사항 |
|---|---|
| **언어** | 한국어 UI + 영문 문서 출력 (이중 언어) |
| **보안** | HTTPS, JWT 인증, 고객 포털 토큰 만료 설정 |
| **접근성** | 주요 기능 모바일 반응형 (고객 포털 필수) |
| **성능** | PDF 생성 3초 이내, 페이지 로드 2초 이내 |
| **백업** | 일 1회 DB 백업, 문서 파일 Cloud Storage |
| **문서 보존** | 발행된 PDF 최소 7년 보관 (무역 서류 법적 의무) |
| **다중 사용자** | 최소 10 동시 접속 지원 |

---

## 11. 기존 코드 재사용 계획

| 기존 파일 | 재사용 방식 | As-Built |
|---|---|---|
| `kmaris_docs.py` | PDF/XLSX 생성 엔진 그대로 사용, 데이터 레이어만 DB로 교체 | 🟢 `services/kmaris_docs.py` |
| `config/company_profile.json` | 회사 정보 | 🟡 DB 테이블 미이관 — `config/company.json` **파일 유지**, Settings에서 편집 |
| `samples/sample_data.json` | 스키마 참조, 개발 테스트 데이터 | 🟢 `init_db.seed_sample_data()` |
| `app.py` (Streamlit) | 내부 도구로 유지 | 🟢 `app/Home.py` + `app/pages/*` 멀티페이지 구조로 확장 |

색상 팔레트 (`NAVY #0B1D3A`, `BLUE #0055A8` 등) 및 문서 레이아웃(헤더·섹션·서명란)은 웹 UI 전체에 통일 적용합니다.

---

## 12. 미결 사항 (To Be Decided)

| 항목 | 옵션 A | 옵션 B | 결정 필요 |
|---|---|---|---|
| Frontend 프레임워크 | Streamlit 확장 (빠름) | React + FastAPI (확장성) | Phase 1 시작 전 |
| 호스팅 환경 | AWS / GCP | 자체 서버 (온프레미스) | 예산 확정 후 |
| 트래킹 포털 URL 방식 | `www.k-maris.com/track/...` (서브패스) | `track.k-maris.com/...` (서브도메인) | 홈페이지 기술 스택 확인 후 결정 |
| 전자세금계산서 연동 | 홈택스 API | ERP 연동 (세무사) | Phase 3 전 |
| 환율 API | 한국은행 API | 자체 수동 입력 | Phase 2 전 |

---

---

## 13. www.k-maris.com 연동 체크리스트

트래킹 포털 개발 시 홈페이지 담당자와 협의가 필요한 항목:

| 항목 | 내용 | 담당 |
|---|---|---|
| 홈페이지 기술 스택 확인 | 어떤 CMS/프레임워크인지 (Webflow, WordPress, Next.js 등) | 웹 담당자 |
| 헤더/푸터 컴포넌트 공유 방법 | iframe embed vs. 공유 컴포넌트 라이브러리 vs. 디자인 복제 | 개발팀 |
| `/track/*` 경로 라우팅 | 서브패스 방식 시 홈페이지 서버에서 KTMS로 프록시 설정 필요 | 인프라 |
| 서브도메인 방식 선택 시 | `track.k-maris.com` DNS 레코드 추가 | 도메인 관리자 |
| 로고·버튼 에셋 동기화 | `kmaris_logo_transparent.png` 등 에셋 버전 통일 | 디자인 담당 |
| Nav 버튼 문구 최종 확정 | "Track your RFQ" / "Track your Order" 한영 표기 결정 | 영업/마케팅 |

---

## 14. As-Built 변경 이력 (v1.1 → v1.2)

실제 구현(`ktms/`)과 대조하여 정정·반영한 항목:

| # | 영역 | v1.1 기술 | v1.2 정정 (As-Built) |
|---|---|---|---|
| 1 | 로드맵 | Phase 1/2 전부 미착수 | Phase 1 완료·Phase 2 진행·Phase 2.5 신규 완료 반영 |
| 2 | 데이터 모델 | Quotation/Order 1:1 강결합 | `rfq_id`/`quotation_id` nullable — 선택적 1:N (orphan 허용) |
| 3 | 트래킹 URL | 경로형 `/track/rfq/{token}` | 쿼리형 API `/api/track?type=&token=`/`&no=` |
| 4 | 인증 | JWT + bcrypt | bcrypt + Streamlit `session_state` (JWT 미사용) |
| 5 | 역할 | 5종 모두 강제 가정 | ADMIN/SALES/VIEWER, Viewer read-only 미강제·Vendor 포털 미구현 |
| 6 | Follow-up Level | 금액 자동 분류 | 수동 선택(기본 B), 자동 규칙 Phase 3 |
| 7 | 회사 정보 | DB `company_settings` 테이블 | `config/company.json` 파일 유지 |
| 8 | 통화 | 페이지마다 상이(JPY 누락) | 공유 상수 `CURRENCIES`로 통일(USD/EUR/KRW/SGD/JPY) |
| 9 | 이메일 자동화 | 6 시나리오 자동 | 견적·VRFQ·SA 구현, Follow-up/연체는 `digest.py`(외부 스케줄러) |
| 10 | Order 필드 | 없음 | `promised_delivery`/`shipped_date`/`delivered_date` 추가(OTD·ETA) |
| 11 | 누락 검증 | 미구현 | `helpers.missing_items` + Documents CI/PL 경고 |

---

*K-MARIS Energy & Solutions Co., Ltd. — Engineering Reliability. Supplying Performance.*
*KTMS PRD v1.2 (As-Built) · Updated 2026-06-14 · 구현 현황 대조·정정 반영*
