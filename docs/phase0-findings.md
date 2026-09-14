# Phase 0 — 현황 조사 결과

**대상**: KTMS 품목 분류 전환 마스터플랜 (`KTMS_분류전환_마스터플랜.md`)
**조사일**: 2026-09-14
**조사 범위**: 코드베이스 전수 + 라이브 DB 읽기 전용 조회 (쓰기 없음)

> 결론부터: **설계안과 실제 구조가 근본적으로 충돌하지는 않는다.** 다만 계획서가 제안한
> "신규 테이블 2개 + item 테이블 컬럼 추가"는 **이미 있는 것을 한 벌 더 만드는 일**이 된다.
> KTMS 에는 이미 분류 마스터 트리가 있고, 품목·거래선·제조사·문서 라인이 그 트리의 id 를
> 가리키고 있다. 같은 목표(품목 기준 2단, 부품/용역 분리)를 **그 트리를 개편해서** 이루는
> 편이 안전하고, 그 개편을 한 번 해 본 장치도 저장소에 있다(§6).

---

## 1. 스택·환경 (계획서 §3 조사 항목)

| 항목 | 실제 |
|---|---|
| 프론트 | Next.js 15(App Router) · React 19 · Vercel (`web/`) |
| 백엔드 | **FastAPI + SQLAlchemy 2.x** (`ktms/`) · Render(싱가포르) |
| DB | **Neon Postgres**(싱가포르, `ep-cool-glade-az4fn1pf`) |
| ORM | SQLAlchemy Declarative (`ktms/db/models.py`) |
| 마이그레이션 도구 | **없음(Alembic 미사용).** `ktms/init_db.py` 가 기동 시마다 돈다: `_MIGRATIONS` dict(표→컬럼 DDL)로 컬럼을 붙이고, 1회성 개편은 `applied_migrations` 마커를 둔 함수로 실행 |
| 스테이징 | **없다.** 로컬 SQLite(`ktms/data/ktms.db`)와 라이브 Neon 뿐 |
| 롤백 | Neon 브랜치/PITR(대시보드) + 스크립트 역산. 마이그레이션 down 파일은 없음 |

계획서가 물은 "Prisma? Drizzle? 수동 SQL?" → **수동에 가깝다.** 컬럼 추가는 선언만 하면
되고(부팅 시 `ALTER TABLE … ADD COLUMN`), 데이터 이관은 별도 스크립트가 맡는다.

---

## 2. 실제 스키마 — Category 는 문자열이 아니다

계획서 §3 의 핵심 질문("문자열 단일 컬럼인가, 3개 컬럼인가, FK 인가")에 대한 답:
**분류 마스터 테이블이 있고, 품목은 그 노드 하나를 FK 로 가리킨다.**

```sql
-- 분류 마스터: 자기참조 트리 (126 노드)
CREATE TABLE item_categories (
  id         SERIAL PRIMARY KEY,
  parent_id  INTEGER REFERENCES item_categories(id),
  level      INTEGER,              -- 1=대 2=중 3=소 (표시용, 강제 아님)
  name       VARCHAR(100) NOT NULL,
  sort_order INTEGER,
  active     BOOLEAN,
  created_at TIMESTAMP
);

-- 품목 마스터 (119건)
CREATE TABLE item_master (
  id          SERIAL PRIMARY KEY,
  part_no     VARCHAR(100) NOT NULL,
  description VARCHAR(400),
  maker       VARCHAR(200),
  origin      VARCHAR(100),
  unit        VARCHAR(20),
  hs_code     VARCHAR(20),
  std_price   DOUBLE PRECISION,
  category_id INTEGER REFERENCES item_categories(id),   -- ← 분류는 여기 한 칸
  item_type   VARCHAR(10) DEFAULT 'part',               -- 'part' | 'service'
  created_at  TIMESTAMP
);
```

트리 현황: 뿌리 7 · 2단 37 · 3단 82 = 126 노드.
뿌리 = Bridge(3) · Deck Machinery(6) · Cargo & Tank System(5) · Engine Room(7) ·
Electrical & Automation(2) · Other Equipment(10) · Service(4).

품목 현황: **119건 전부 `category_id` 가 채워져 있다**(미분류 0). `item_type` 은
part 95 · service 24. `maker` 가 채워진 건 23건뿐(계획서 §8-1 의 근거와 일치).

> 화면의 "Unmatched (24)" 는 미분류가 아니라 **문서에는 있으나 마스터에 연결되지 않은
> 품목 줄**이다(가격 이력 집계의 부산물). 계획서의 "미분류 0건" 성공 기준과는 다른 지표다.

---

## 3. Category 를 참조하는 지점 — 계획서가 모르던 것들

품목만 분류를 쓰는 게 아니다. **같은 트리의 id 를 네 곳이 더 가리킨다.**

| 참조처 | 실제 | 영향 |
|---|---|---|
| `item_master.category_id` | 119건 | 이관 대상(계획서가 아는 유일한 곳) |
| **`vendors.category_ids`** (JSON) | **52줄이 31개 노드** 참조 | 거래선 "취급 분류" 태그. 노드를 지우면 태그가 사라진다 |
| **`makers.category_ids`** (JSON) | **18줄이 9개 노드** 참조 | 제조사 "만드는 분류" 태그 |
| **문서 라인 JSON** `items[].category_id` | RFQ·Quotation·Order·PurchaseOrder | 입력 시 고른 분류가 문서에도 남는다. 안 고치면 그 줄만 `(#id)` 로 뜬다 |
| 벤더 추천 `services/vendor_match.py:339` | `category_ids` 로 후보 선정 | 트리가 바뀌면 추천 근거가 바뀐다 |

화면 쪽 참조(파일:라인):

- `web/app/settings/page.tsx` — 분류 트리 편집(좌측), 가격 이력 표(우측), 품목 마스터 표의
  Category 열, Auto-assign, Rebuild, 인쇄 칸 (`ledgerPrintCols`·`itemPrintCols`)
- `web/components/common/CategoryTags.tsx` — 거래선·제조사의 분류 태그 선택기/배지
- `web/components/common/CategoryCell.tsx` — 품목표 셀에서 분류 고르기
- `web/components/screens/NewRfqForm.tsx:88,267,1026` · `RfqActionTabs.tsx` · `PoScreen.tsx`
  — 문서 입력 시 줄마다 분류 선택
- **`web/components/screens/ShipMapTab.tsx` + `web/lib/shipZones.ts`** — Ship View 는
  **대분류 이름 문자열**로 갑판을 정한다(`BERTH: "ENGINE ROOM"→기관실 …`).
  이름을 바꾸면 그 카드는 "부두(Quay)"로 떨어진다. 무너지지는 않지만 **Ship View 는
  위치 기준 화면이라, 품목 기준 2단으로 바꾸면 이 화면의 전제가 사라진다**(§7 미해결).
- `ktms/services/item_ledger.py:306-350` — 문서 라인의 `category_id` 를 품목 마스터로
  역반영(입력이 곧 분류가 되는 경로). 이관 후에도 이 경로가 구 분류를 되살릴 수 있다.

---

## 4. 매핑 키 — `No.` 는 KTMS 의 식별자가 아니다 (해결됨)

계획서 §6 이 "Phase 0 에서 확인하라"고 한 항목. 결과:

- `No.` ↔ `item_master.id` 일치: **0 / 119**. id 는 2~138 로 비연속이다. `No.` 는
  내보낸 목록의 줄 번호일 뿐 KTMS 의 키가 아니다.
- Description 완전일치: **1:1 87건 · 동명이인 32건 · 못 찾음 0건**.
- 그 87건의 **현행 Category 는 DB 와 100% 일치** — 이 시트가 이 데이터에서 나왔음이 확인된다.

동명이인 32건은 계획서가 걱정한 대로 Description 만으로는 못 가른다. 그래서
**(품명 + 현행 분류)** 로 묶어 다시 셌다:

```
DB 묶음 101 · 시트 묶음 101 · 키 집합 동일: True
묶음마다 건수도 일치(어긋난 묶음 0)
한 묶음이 한 코드만 가리킴(결정적): 119건
묶음 안에서 코드가 갈림(REVIEW 후보):   0건
```

**즉, 어느 시트 행이 어느 DB 행의 짝인지 몰라도 결과가 같다.** 같은 품명·같은 현행 분류의
행들은 모두 같은 (대분류, 부품코드)를 가리키기 때문이다. 추측 없이 **119/119 를 결정적으로
매핑할 수 있다** — REVIEW 로 남길 건이 없다(계획서는 SVC 9건을 REVIEW 로 표시하라고 했는데,
그건 매핑 불확실성이 아니라 '용역 트리로 보낸다'는 성격 표시다).

판정 분포는 시트와 같다: OK 52 · MOVE 42 · NEW 16 · SVC 9.
대분류 분포: EN 32 · TS 29 · VP 20 · AU 19 · EA 11 · TR 3 · DK 2 · HW 2 · SF 1.
부품코드가 붙은 건 87건(나머지 32건은 TS/TR 등 대분류만).

**SVC 9건 확인**: 9건 모두 KTMS 에서 `item_type='part'` 로 서 있다(용역인데 부품으로 집계
중이라는 계획서의 지적이 그대로 사실). 반면 KTMS 는 이미 `item_type='service'` 인 24건을
따로 들고 있다 — **부품/용역 분리 축이 이미 있고**, 계획서의 "별도 트리"는 이 축과
트리를 맞추는 일이 된다.

---

## 5. 계획서와 다른 점 (항목별)

| 계획서 | 실제 | 판단 |
|---|---|---|
| Category = 문자열/3컬럼 가능성 | **트리 마스터 + FK 한 칸** | 설계 교정 필요 |
| 신규 테이블 `item_category`(code PK) | `item_categories`(id PK, 자기참조) 이미 존재 | **새 표 대신 기존 트리 개편** 권고 |
| 신규 테이블 `item_major` | 트리의 1단이 그 역할 | 1단을 15개 대분류로 갈아 끼우면 된다 |
| 품목만 Category 를 참조 | **거래선 52줄·제조사 18줄·문서 라인 JSON 도 참조** | 이관 범위 확대 필요 |
| `No.` 로 매칭 | `No.` 는 KTMS 키가 아님 | (품명+현행분류) 묶음으로 대체, 결정적 |
| 애매한 건 REVIEW | 애매한 건 **0** | REVIEW 불필요 |
| 미분류 0건 만들기 | 이미 미분류 0건 | 성공 기준 재정의 필요(§7) |
| 부품/용역 분리 | `item_type` 으로 이미 절반 되어 있음 | 트리를 그 축에 맞추는 일 |
| 마이그레이션 up/down | Alembic 없음 | `init_db` 컬럼 추가 + 1회성 함수 + 역산 스크립트 |
| 스테이징에서 검증 | 스테이징 없음 | **로컬 SQLite 에 라이브 사본을 떠서** 리허설 |

---

## 6. 선례 — 이 개편은 한 번 해 본 일이다

`ktms/init_db.py:724 migrate_restructure_item_categories()` 가 이미 **1단 축을 통째로
바꾼 적이 있다**(구: Service/Parts → 현: 위치·계통). 그때 쓴 장치가 그대로 남아 있다:

- `_CATEGORY_RENAME` / `_CATEGORY_PROMOTE` / `_CATEGORY_MOVE` — 이름 바꾸기, 자리 올리기,
  참조 옮기고 지우기
- `_remap_line_categories(s, remap)` (`:665`) — **문서 JSON 안의 `category_id` 까지** 옮긴다
- `applied_migrations` 마커로 1회만 실행
- **id 를 최대한 살린다**는 원칙 — 그 분류를 쓰던 품목·문서·태그가 그대로 새 자리를 가리킨다

이번 전환도 같은 방식이 맞다. 새 표를 만들어 두 체계를 병행하면, 위 §3 의 다섯 참조처를
전부 두 벌로 유지해야 한다.

---

## 7. Phase 1 설계 수정 제안

### 7-1. 트리 개편 (새 표 없음)

`item_categories` 를 **2단**으로 다시 세운다.

- **1단 = 대분류 15종**(`01_대분류`): EN·AU·HT·VP·DK·EA·EV·SF·NC·AO·HW(품목) / TS·TR(용역) /
  SB·BU(속성 — 트리에 넣지 않음, 계획서 §2-4)
- **2단 = 부품 145종**(`02_부품레벨_145`): `EN-001` 등
- `level` 은 1·2 만 쓴다. 3단 노드는 만들지 않는다.

노드 이름 표기 제안: `EN-001 Fuel Injector / 연료분사밸브` 처럼 **코드를 이름 앞에** 둔다.
현 스키마에는 code 칸이 없기 때문인데, 아래 7-2 로 칸을 만들면 이름은 영문명만 둔다.

### 7-2. 컬럼 추가 (기존 칸은 건드리지 않음)

`item_categories` 에:

| 컬럼 | 타입 | 뜻 |
|---|---|---|
| `code` | VARCHAR(20) | `EN` / `EN-001` (유일) |
| `name_ko` | VARCHAR(100) | 국문명 |
| `tree_type` | VARCHAR(10) | `part` / `service` / `attribute` |
| `hs_code` | VARCHAR(20) | 참고값 |

`item_master` 에:

| 컬럼 | 타입 | 뜻 |
|---|---|---|
| `legacy_category` | VARCHAR(300) | 이관 시점 원본 경로 문자열 스냅샷 |
| `legacy_category_id` | INTEGER | 이관 시점 원본 노드 id |
| `migration_status` | VARCHAR(12) | `MIGRATED` / `REVIEW` |
| `migration_note` | VARCHAR(300) | 판정·이슈 |
| `supply_channel` / `product_line` | VARCHAR(20) | SB / BU (계획서 §2-4) |

> 계획서의 `category_code` 는 두지 않는다 — `category_id` 가 새 노드를 가리키고 그 노드가
> `code` 를 들고 있으므로, 같은 사실을 두 곳에 적는 것이 된다(어긋나면 어느 쪽이 맞는지
> 알 수 없다).

### 7-3. 이관 순서

1. 새 대분류 15 + 부품 145 노드를 **추가**(기존 노드는 그대로 둔 채)
2. 119건의 `category_id` 를 새 노드로 옮기고 `legacy_*` 에 원본을 남긴다
3. **거래선 52줄·제조사 18줄의 태그**를 대분류로 환산해 옮긴다(부품 레벨까지 내리지 않는다 —
   "이 회사가 이 부품 하나만 다룬다"는 뜻이 되어 버린다)
4. **문서 라인 JSON** 의 `category_id` 를 `_remap_line_categories` 로 옮긴다
5. 구 노드는 **지우지 않고 `active=false`** 로 내린다(계획서 §2-2 레코드 삭제 금지와 같은 뜻)
6. 리허설은 라이브 사본을 로컬 SQLite 로 떠서, 같은 스크립트를 dry-run → 검증 → 적용

---

## 8. 멈춰 서서 물어야 할 것 (승인 요청)

1. **Ship View 를 어떻게 할 것인가.** 이 화면은 "배 어디에 있나"를 축으로 만든 것이라,
   품목 기준 2단으로 바꾸면 전제가 사라진다. ① 대분류 15종을 갑판에 다시 앉힌다
   ② 위치 축을 별도 속성으로 남긴다 ③ 화면을 접는다 — 셋 중 하나를 골라야 한다.
2. **거래선·제조사 태그(70줄)를 대분류로 환산해도 되는가.** 현재는 `Engine Room >
   Main Engine System` 같은 계통 태그다. 새 체계에서 가장 가까운 값은 `EN`(대분류)이다.
3. **구 트리를 언제 내릴 것인가.** 계획서 §2-1 은 "최소 1개 분기 유지"라 했다. 그동안
   화면에는 두 체계가 함께 보인다 — 새 분류만 보이게 하고 구 분류는 편집창에서만
   읽기로 둘지.
4. **SB/BU 속성 칸을 이번에 만들 것인가**(계획서 §8-3 은 "시점 미정"으로 남겨 두었다).

---

## 9. 다음 단계

계획서 §2-7 에 따라 **여기서 멈춘다.** 위 §7 설계와 §8 네 가지에 대한 승인을 받은 뒤
Phase 1(컬럼 추가) → Phase 2(마스터 적재) → Phase 3(119건 이관, 드라이런 먼저)로 간다.

조사에 쓴 스크립트는 전부 읽기 전용이었고, **라이브 DB 에 쓴 것은 없다.**
