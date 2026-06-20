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
# API 기동 (토큰은 임의 지정 가능)
ADMIN_API_TOKEN=dev-token python -m uvicorn admin_api:app --reload --port 8001
```

- `GET /api/admin/rfq-overview` — RFQ 통합 현황 (헤더 `Authorization: Bearer <token>` 필요)
- `GET /api/admin/customers` — Customer 필터 옵션
- `GET /health` — 헬스체크

운영 DB(Postgres)에 붙이려면 `ktms/.env`의 `DATABASE_URL`을 채우면 된다.

## 2) 프론트엔드 실행 (Next.js)

```bash
cd web
cp .env.local.example .env.local   # NEXT_PUBLIC_API_BASE / NEXT_PUBLIC_ADMIN_TOKEN 확인
npm install
npm run dev      # http://localhost:3000
```

## 구현된 것

- 진짜 `<table>` 기반 RFQ 현황 — zebra 줄무늬 / hover / 행 클릭+체크박스 선택 /
  2줄 셀(번호 + 일시 캡션) / 숫자 우측정렬(등폭) / 가로 스크롤 / sticky 헤더
- 12단계 진행을 미니 progress bar + `n/12 라벨`로 표시
- Customer 필터, 새로고침, 선택 건 상세 패널

## 아직 안 된 것 (다음 단계)

- 인증: 지금은 파일럿용 정적 토큰(`NEXT_PUBLIC_ADMIN_TOKEN`). → FastAPI 로그인(JWT)로 교체,
  기존 `users` 테이블의 bcrypt 해시 재사용
- 나머지 화면(CRFQ/VRFQ/Quotation/PO/Documents/AR/Settings) 이관
- 상세 패널의 실제 액션(신규 등록·발신·수신) API 연결
- 배포: web → Vercel, admin_api → 상시 호스트(Railway/Render 등)
