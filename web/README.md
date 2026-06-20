# KTMS Admin — Next.js pilot

Vercel(Next.js) 전환 파일럿. RFQ & Quotation 현황 화면 한 개를 React로 구현하고,
기존 Python(SQLAlchemy) 데이터/로직을 FastAPI로 노출해 연동한다.

```
[Next.js (web/)]  ──HTTP+Bearer──▶  [FastAPI (ktms/admin_api.py)]  ──▶  DB (sqlite 로컬 / Postgres 운영)
```

## 1) 백엔드 실행 (FastAPI)

```bash
cd ktms
# 로컬 sqlite에 샘플 RFQ 시드 (최초 1회)
python seed_pilot.py
# API 기동 (Windows에서 --reload는 포트가 가끔 멈추니 생략 권장)
ADMIN_API_TOKEN=dev-token python -m uvicorn admin_api:app --port 8002
```

- `POST /api/admin/login` — 로그인 → `{token, user}` (기존 users 테이블 bcrypt 검증)
- `GET  /api/admin/me` — 현재 사용자 (JWT 필요)
- `GET  /api/admin/rfq-overview` — RFQ 통합 현황
- `GET  /api/admin/rfq/{id}` — RFQ 상세(품목·12단계·연결문서)
- `GET  /api/admin/dashboard` — 운영 현황 KPI/분포/최근
- `GET  /api/admin/customers` — Customer 필터 옵션
- `GET  /health` — 헬스체크

보호 엔드포인트는 `Authorization: Bearer <JWT>` 필요(파일럿 한정으로 정적 `dev-token`도 허용).
운영 DB(Postgres)에 붙이려면 `ktms/.env`의 `DATABASE_URL`을 채우면 된다.
기본 로그인 계정: **admin / admin1234**.

## 2) 프론트엔드 실행 (Next.js)

```bash
cd web
cp .env.local.example .env.local   # NEXT_PUBLIC_API_BASE / NEXT_PUBLIC_ADMIN_TOKEN 확인
npm install
npm run dev      # http://localhost:3000
```

## 구현된 것

- **로그인(JWT)** — 기존 `users`(bcrypt) 재사용, `/login` 페이지 · 토큰 저장 · 라우트 가드 · 로그아웃
- **RFQ 현황** — 진짜 `<table>`: zebra / hover / 행 클릭+체크박스 선택 / 2줄 셀(번호+일시) /
  숫자 우측정렬 / 가로 스크롤 / sticky 헤더 / 12단계 progress bar
- **RFQ 상세 패널** — 품목 테이블 · 12단계 세로 스텝 · 연결문서(Vendor RFQ/Quote/Quotation)
- **운영 현황(Dashboard)** — KPI 카드 · 12단계 분포 차트 · 최근 RFQ
- 상단 공용 네비게이션(RFQ ↔ Dashboard), Customer 필터, 새로고침

## 아직 안 된 것 (다음 단계)

- 상세 패널의 실제 액션(신규 등록·발신·수신) 쓰기 API + 폼
- 나머지 화면(CRFQ/VRFQ/Quotation/PO/Documents/AR/Settings) 이관
- 토큰 저장을 localStorage → httpOnly 쿠키로, 리프레시 토큰
- 배포: web → Vercel, admin_api → 상시 호스트(Railway/Render 등)
