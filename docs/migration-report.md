# 품목 분류 전환 — 이관 결과

**실행일**: 2026-09-14
**대상**: 라이브(Neon) · 품목 119건 · 거래선/제조사 태그 70줄 · 문서 라인 41줄
**근거**: `KTMS_분류전환_마스터플랜.md` · `KTMS_분류전환_마스터통합.xlsx`
**사전 조사**: `docs/phase0-findings.md` (Phase 0, 승인 완료)

---

## 0. 승인받은 네 가지 결정

| 물음 | 결정 |
|---|---|
| Ship View 를 어떻게 할까 | **대분류 15종을 갑판에 다시 앉힌다** |
| 거래선·제조사 태그를 대분류로 환산해도 되는가 | 한 회사는 여러 부품을 다룬다 → **대분류로 환산**(부품 레벨로 내리지 않음) |
| 구 트리를 언제 내릴까 | **신 트리가 안정되면** — 지금은 지우지 않고 내려만 둔다 |
| SB/BU 속성 칸을 만들까 | **아직 만들지 않는다** |

---

## 1. 무엇이 바뀌었나

**위치 축 3단 → 품목 축 2단.**

```
전:  Engine Room > Main Engine System > Piston      (7 뿌리 · 126 노드 · 3단)
후:  EN Engines & power systems > EN-001 Fuel Injector   (13 대분류 · 145 부품 · 2단)
```

새 트리는 `item_categories` 에 **덧세웠다**(새 표 없음). 그 트리를 가리키는 곳이 품목만이
아니기 때문이다 — 거래선·제조사 태그, RFQ·견적·오더·발주서의 라인 JSON 이 같은 id 를
쓴다(Phase 0 §3).

---

## 2. 반영 결과 (검증 통과)

```
품목        119건 이동 (매핑 못 찾음 0)
태그        70줄 이동 (거래선 52 · 제조사 18)
문서 라인   41줄 이동 (RFQ·견적·오더·발주서 JSON)
구 노드     126개 내림(active=false — 삭제 아님)
부품→용역   9건 (item_type 교정)
```

마스터플랜 §6 검증 기준:

| 기준 | 결과 |
|---|---|
| `migration_status IS NULL` = 0 | ✅ 0 (MIGRATED 110 · REVIEW 9) |
| `category_id IS NULL` = 0 | ✅ 0 |
| `legacy_category` 전건 채워짐 | ✅ 119/119 |
| 원본 Category 손실 없음 | ✅ `legacy_category`(경로) + `legacy_category_id`(노드 id) 로 보존 |
| 부품 마스터 145 적재 | ✅ AU 18 · DK 12 · EA 11 · EN 45 · EV 11 · HT 13 · HW 3 · SF 8 · VP 24 = **145** |

판정 분포는 시트와 정확히 같다: **OK 52 · MOVE 42 · NEW 16 · SVC 9**.

대분류별 품목 수: `EN 32 · TS 29 · VP 20 · AU 19 · EA 11 · TR 3 · DK 2 · HW 2 · SF 1`
(HT·EV·NC·AO 는 아직 품목이 없는 빈 대분류 — 자리는 서 있다)

---

## 3. 짝을 어떻게 찾았나 (추측 없음)

매핑 시트의 `No.` 는 KTMS 식별자가 아니었다(`item_master.id` 와 0/119 일치). 품명만으로는
32건이 동명이인이다. **(품명 + 구 분류 경로)** 로 묶으니:

- DB 101 묶음 ≡ 시트 101 묶음, **키 집합 동일**, 묶음마다 건수도 동일
- 한 묶음 안의 행들이 **모두 같은 코드**를 가리킴 → 어느 행이 어느 행의 짝인지 몰라도 결과가 같다

그래서 119건 전부를 결정적으로 옮겼고 REVIEW 로 남길 매핑 불확실성은 없었다.
(REVIEW 9건은 매핑이 애매해서가 아니라 **성격이 바뀌었다**는 표시다 — §4)

---

## 4. REVIEW 9건 — 부품으로 서 있던 용역

트리만 옮기면 통계는 그대로 오염된다. 아홉 건은 `item_type` 도 part → service 로 바꿨고,
`migration_status='REVIEW'` 를 달아 두었다.

| 품명 | 있던 자리 | 간 곳 |
|---|---|---|
| Genset fabrication and inspection | Engine Room > Electrical Power System | TS |
| Consumable materials | Deck Machinery > Crane | TS |
| Diassembly of hyd. Cylinder onboard | Deck Machinery > Crane | TS |
| Fabrication of copper bearings | Deck Machinery > Crane | TS |
| Fabrication of cylinder pins | Deck Machinery > Crane | TS |
| Hyd. cylinder overhaul at workshop | Deck Machinery > Crane | TS |
| Reinstallation of hyd. Cylinder onboard | Deck Machinery > Crane | TS |
| Shore crane service at the workboat terminal | Deck Machinery > Crane | TS |
| DG3 MAIN BRG 및 CONNECTING ROD 점검 SERVICE CHARGE | Engine Room > Main Engine System > Con. Rod | TS |

이제 Parts 탭 86건 · Service 탭 33건이다(전 95 / 24).

---

## 5. 태그 70줄 — 왜 통계가 아니라 이름으로 옮겼나

처음에는 "그 노드에 있던 품목이 어디로 갔나"로 세었다. 뜻이 어긋났다:

- `Deck Machinery > Crane` 의 품목은 대부분 **수리 용역비(TS 36%)와 유압밸브(VP 36%)** 였다.
  그러나 거기 태그가 붙은 회사는 **크레인을 대 주는 곳(DK)** 이다. 표본은 "우리가 최근
  무엇을 샀나"일 뿐이고 태그는 "그 회사가 무엇을 다루나"다.
- 게다가 태그가 붙은 33개 노드 중 **19개는 품목이 아예 없어** 셀 것이 없었다.

그래서 이름이 말하는 뜻을 표로 적었다(`services/item_taxonomy.LEGACY_TAG_MAJORS`, 40줄).
결과는 태그 수가 **줄거나 그대로**다 — 통계 방식에서 나던 "2개 → 6개" 같은 부풀림이 없다.

```
Engine Room > Main Engine System → EN      Deck Machinery > Crane      → DK
Engine Room > Hydraulic System   → VP      Cargo & Tank System > Valve → VP
Other Equipment > BWTS           → EV      Bridge > Control            → NC
Service > Other Service          → TS, TR  Other Equipment(뿌리)       → EN, HT, EV
```

전체 표는 코드에 있다. **추정이 섞인 자리이므로 화면에서 확인하고 고쳐도 된다** — 태그는
거래선 추천(vendor_match)의 근거라 틀리면 추천이 넓어지거나 좁아진다.

---

## 6. 되돌리기

세 겹으로 남겨 두었다.

1. **품목**: `legacy_category`(경로 문자열) + `legacy_category_id`(노드 id) 전건 보존.
   되돌리려면 `category_id = legacy_category_id`, `migration_* = NULL`.
2. **구 노드**: 지우지 않았다(`active=false` 126개). 되살리려면 `active=true`.
3. **스냅샷 파일**: 이관 직전 상태(분류 126 · 품목 119 · 거래선 52 · 제조사 18 ·
   문서 라인 63)를 JSON 으로 따로 떴다.

컬럼 추가는 되돌릴 필요가 없다(기존 칸을 건드리지 않았다).

---

## 7. 화면 쪽에서 함께 고친 것

- **Ship View**: 갑판 배치를 **코드 기준**으로 바꿨다(이름은 관리자가 고칠 수 있다).
  선교·상부 `SF·NC·AO` / 갑판 `DK` / 기관·전장 `EN·AU·HT·VP·EA·EV` / 부두 `HW·TS·TR`.
- **분류 트리 편집기**: 새 트리는 2단에서 멈춘다(`Major > Part`). 3단으로 다시 자라면
  전환 전의 문제로 돌아간다.
- **부품/용역 가르기**: 이름(`"SERVICE"`)이 아니라 `tree_type` 으로 판별한다.
- **품목 편집창**: "Was classified as" 줄에 옮기기 전 자리와 판정을 읽기 전용으로 세웠다.
- **되돌림 방지 장치**: 문서를 저장하면 라인의 `category_id` 가 품목 마스터로 반영되는
  경로가 있다(`item_ledger.apply_line_categories`). **내려 둔 구 분류는 마스터를 되돌리지
  못하게** 막았다 — 이 장치가 없으면 옛 문서를 한 번 다시 저장할 때마다 그 품목이 옛
  자리로 끌려간다.

---

## 7-2. 구 트리 철거 (2026-09-14, 전환 당일)

전환 결과를 화면에서 확인한 뒤 구 노드 126개를 **삭제**했다(결정 3 의 "신 트리가 안정되면
내리죠"). 지우기 전 세 곳을 전수 확인했다:

| 확인 | 결과 |
|---|---|
| 구 노드를 가리키는 품목 | 0 |
| 거래선·제조사 태그에 남은 구 노드 | 0 |
| 부모가 구 노드인 새 노드 | 0 |
| **문서 라인에 남은 구 노드** | **22줄(RFQ 5건)** |

22줄은 품목 마스터에 없는 줄(Unmatched 24건)이라 옮겨 갈 짝이 없었다. **분류 값을
비웠다**(`category_id = null`) — 분류의 정본은 품목 마스터이고 라인의 분류는 입력 시
고른 힌트일 뿐이다. 노드를 지운 채 번호만 남겨 두면 화면에 `(#id)` 로 뜬다. 비워 두면
Auto-assign 이 그 줄을 제안 대상으로 집는다.

철거 후: **분류 노드 158개**(대분류 13 + 부품 145) · 비활성 0 · 코드 없는 노드 0.
품목 119건 전부 분류를 갖고 있고, `legacy_category`(옮기기 전 경로 문자열) 119건도 그대로다 —
**노드는 사라졌어도 "어디에 있었나"는 그 글자가 답한다.**

지우기 직전 상태(노드 126 + 문제의 라인 22줄)를 JSON 으로 따로 떠 두었다.

함께 걷어낸 코드: 구 트리 이름으로 갑판을 찾던 표(`shipZones.BERTH`), 3단(Detail) 층을
전제하던 편집기 규약(이제 `Major > Part` 2단에서 멈춘다).

---

## 8. 남은 일 (마스터플랜 §8 — 자동화하지 않고 목록만)

1. **Maker 분리**: Description 꼬리에 메이커가 붙은 건(`…, KK` → Maker=KK).
   현재 119건 중 maker 가 채워진 건 23건뿐이다.
2. **중복 의심**: 품명 완전일치 32건(63/64 Jib Top Wire Sheave, 114/116/118/119 MAIN
   CONTROL VALVE OVERHAUL KIT …). **규격이 달라 별개 품목일 가능성이 높다 — 병합하지 않았다.**
3. **미해결 판단**(사용자 결정 필요): 50A 볼밸브 2건의 계통 · 발전기 베어링 EN-043 의
   DE/NDE 분할 · 호이스팅 모터 씰킷을 VP-024 로 둘지 DK 로 옮길지 · SB/BU 속성 전환 시점.
4. ~~구 트리 철거~~ — 전환 당일 완료(§7-2).
