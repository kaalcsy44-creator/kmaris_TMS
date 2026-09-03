"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ProjectNo from "@/components/common/ProjectNo";
import { assignItemLedgerCategory, fetchItemShipMap } from "@/lib/api";
import { invalidateCache, useCachedData } from "@/lib/useCachedData";
import type { ShipDeal, ShipItem, ShipMap } from "@/lib/types";
import { useVendorLogo } from "@/lib/vendorLogos";

/**
 * Ship View — 분류 트리를 목록이 아니라 배 한 척으로 펼친 화면.
 *
 * 왜 또 하나의 보기인가. Item Category 탭은 분류를 하나 골라 그 안을 들여다보는
 * 창이라, 배 전체가 지금 어떤 상태인지는 끝내 보이지 않는다 — 어느 계통이 붐비고
 * 어느 계통이 비어 있는지, 어느 프로젝트가 어느 계통에 걸려 있는지는 한 화면에
 * 나란히 놓여야 비로소 읽힌다. 그래서 이 탭은 한 페이지에 분류를 전부 세우고,
 * 그 자리를 배의 자리(선교·갑판·기관실·부두)로 잡는다.
 *
 * 배치는 이름으로 잡되 강제하지 않는다. 분류 트리는 관리자가 고칠 수 있으므로,
 * 아는 이름은 제자리에 세우고 모르는 이름은 부두에 세운다 — 트리를 바꿨다고 화면이
 * 무너지면 안 된다(BERTH 참고).
 *
 * 잎은 분류가 아니라 프로젝트다. 계통마다 그 계통의 품목이 나온 프로젝트 번호가
 * 붙고, 그 번호나 분류에 마우스를 올리면 거기 걸린 품목의 내역(품번·품명·최근
 * 매입·매출·상대처)이 그 자리에서 펼쳐진다.
 */

/**
 * 갑판 — 카드가 스스로 달고 다니는 이름표. 자리(격자 칸)로 갑판을 나누지 않는다:
 * 계통마다 부피가 열 배씩 차이 나서(기관실 아홉 계열 vs 선교 셋), 칸을 갑판으로
 * 못 박으면 어떤 칸은 안에서 스크롤하고 어떤 칸은 절반이 빈 채로 남는다.
 * 이름표를 카드에 붙여 두면 카드는 어느 열에 놓여도 제 갑판을 말한다.
 */
const DECKS = [
  { name: "Bridge & upper deck", sub: "선교·상부" },
  { name: "Main deck", sub: "갑판·화물" },
  { name: "Machinery spaces", sub: "기관·전장" },
  { name: "Quay", sub: "육상·용역" },
] as const;

/**
 * 대분류 이름 → 갑판. 기본 트리(init_db.ITEM_CATEGORY_TREE)의 일곱 대분류를 제자리에
 * 세운다. 여기 없는 이름은 부두로 간다 — 자리를 못 찾은 것이지 잘못된 것이 아니므로
 * 화면에서 빠지지는 않는다(관리자가 트리를 고쳐도 화면이 무너지지 않는다).
 */
const BERTH: Record<string, number> = {
  "BRIDGE": 0,
  "DECK MACHINERY": 0,
  "CARGO & TANK SYSTEM": 1,
  "CARGO AND TANK SYSTEM": 1,
  "ENGINE ROOM": 2,
  "ELECTRICAL & AUTOMATION": 2,
  "OTHER EQUIPMENT": 2,
  "SERVICE": 3,
};

/** 소분류를 두 단으로 접을 기준 — 이보다 계열이 많은 카드(기관실)는 안에서 나눈다. */
const WIDE_SUBS = 6;

/**
 * 대분류의 표식 — 한 획짜리 선 그림. 색을 쓰지 않는다(글자색을 그대로 물려받는다).
 * 이모지는 브라우저마다 다른 그림이 나오고, 저마다 제 색을 들고 와서 카드 여섯 장이
 * 색동옷처럼 보였다. 여기서 아이콘이 할 일은 '어느 계통인가'를 반 박자 먼저 알리는
 * 것뿐이라, 형태만 다르고 색은 하나여야 한다.
 */
const ICON: Record<string, React.ReactNode> = {
  // 나침반 — 선교.
  "BRIDGE": <><circle cx="12" cy="12" r="8.5" /><path d="M15.6 8.4 13.1 13.1 8.4 15.6l2.5-4.7z" /></>,
  // 앵커 — 갑판 기계.
  "DECK MACHINERY": <><circle cx="12" cy="4.6" r="2.1" /><path d="M12 6.7V21M7.2 10.2h9.6M3.8 14.4A8.2 8.2 0 0 0 20.2 14.4" /></>,
  // 탱크(드럼) — 화물·탱크.
  "CARGO & TANK SYSTEM": <><ellipse cx="12" cy="6" rx="6" ry="2.2" /><path d="M6 6v12c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2V6" /><path d="M6 12.2c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2" /></>,
  // 톱니 — 기관실.
  "ENGINE ROOM": <><circle cx="12" cy="12" r="3.2" /><circle cx="12" cy="12" r="7.2" /><path d="M12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4M5.2 5.2 6.9 6.9M17.1 17.1l1.7 1.7M18.8 5.2 17.1 6.9M6.9 17.1 5.2 18.8" /></>,
  // 번개 — 전기·자동화.
  "ELECTRICAL & AUTOMATION": <path d="M13.2 2.5 4.8 13.6h6.1l-1 7.9 8.3-11.1h-6.1z" />,
  // 육각 너트 — 그 밖의 장비.
  "OTHER EQUIPMENT": <><path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z" /><circle cx="12" cy="12" r="3" /></>,
  // 공구함 — 용역.
  "SERVICE": <><rect x="3.2" y="8.2" width="17.6" height="11" rx="2" /><path d="M9 8.2V6.4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.8M3.2 13.2h17.6" /></>,
};

/** 표식 한 칸 — 선 굵기와 크기를 한 곳에서 잡는다(모두 같은 무게로 보여야 한다). */
function Mark({ name }: { name: string }) {
  const art = ICON[name.trim().toUpperCase()];
  return (
    <svg className="ship-zone-mark" viewBox="0 0 24 24" aria-hidden
         fill="none" stroke="currentColor" strokeWidth="1.5"
         strokeLinecap="round" strokeLinejoin="round">
      {art ?? <rect x="4.5" y="4.5" width="15" height="15" rx="3.5" />}
    </svg>
  );
}

type Cat = ShipMap["categories"][number];
type VendorMark = NonNullable<ShipMap["vendor_marks"]>[number];

/** 화면이 쓰는 모양으로 한 번 갈아 둔 트리 — 부모·자식, 분류별 품목, 롤업. */
type ShipModel = {
  kids: Map<number | null, Cat[]>;
  roll: Map<number, ShipItem[]>;   // 그 분류와 그 아래 전부의 품목
  roots: Cat[];
  loose: ShipItem[];               // 분류가 없어 배에 못 실은 품목
  /**
   * 계통 → 그 계통을 다루는 거래선. 이 판이 지금까지 말하지 못한 것을 말하게 한다.
   *
   * 'Cooling Water System 0' 은 두 가지 중 하나다 — 아직 일이 없었거나, 물어볼 데가
   * 없거나. 전자는 그냥 조용한 것이고 후자는 소싱의 구멍인데, 숫자 0 으로는 갈리지
   * 않는다. 옆에 거래선이 서 있으면 갈린다.
   */
  marks: Map<number, VendorMark[]>;
  /**
   * 판에서 자리를 옮길 때 고르는 목록 — '대 > 중 > 소' 전체 경로다.
   * 이름만 적으면 못 고른다: 'Filter'·'Pump'·'Engine' 처럼 여러 계통에 같은 이름이
   * 있어(Fuel Oil System·Lubricating Oil System 둘 다 Filter 를 갖는다) 어느 쪽인지
   * 경로 없이는 갈리지 않는다. 배 읽는 순서(roots)를 그대로 물려받아 늘어놓는다.
   */
  places: { id: number; path: string }[];
};

/**
 * 올렸을 때와 눌렀을 때가 답하는 것이 다르다.
 *
 * 앞서는 올리기만 해도 품목 내역이 통째로 펴졌고, 거기에 브라우저 기본 툴팁(title)까지
 * 겹쳐 두 가지가 같은 자리에서 서로를 가렸다. 올리는 것은 지나가는 손짓이고 누르는 것은
 * 들여다보겠다는 손짓이니 나오는 것도 그만큼 달라야 한다 — 올리면 '무엇인가' 한 줄,
 * 누르면 '무엇이 들었나' 전부.
 */
type Hint = { text: string; x: number; y: number } | null;

/**
 * 눌러서 펴는 판 — 그 자리에 걸린 품목 전부. href 가 있으면 그리로 가는 길도 함께.
 *
 * 제목이 글자가 아니라 조각(ReactNode)인 까닭은 프로젝트 번호 때문이다. P-013 과
 * (260721) 은 무게가 달라야 한다 — 앞은 이름이고 뒤는 언제 들어온 건인지를 덧붙인
 * 것이라, 같은 굵기로 붙어 있으면 번호가 여섯 자리 더 긴 것처럼 읽힌다. 다른 목록이
 * 쓰는 ProjectNo 가 그 둘을 갈라 놓으므로 여기서도 그대로 쓴다.
 */
type Panel = {
  title: React.ReactNode;
  sub: React.ReactNode;
  items: ShipItem[];
  href?: string;
  /**
   * 프로젝트 칩에서 편 판이면 그 프로젝트. 품목마다 붙는 프로젝트 번호에서 이것만 뺀다 —
   * 이 판에 실린 품목은 전부 그 프로젝트의 것이라, 줄마다 같은 번호를 되풀이하면
   * 나머지 번호(그 품목이 함께 걸린 다른 건)가 그 안에 묻힌다.
   */
  dealId?: number;
  x: number;
  y: number;
} | null;

function berthOf(name: string): number {
  const k = (name || "").trim().toUpperCase();
  return BERTH[k] ?? DECKS.length - 1;   // 모르는 계통은 부두에 내려놓는다.
}

/**
 * 칩에 적는 이름 — 프로젝트 번호(P-001)다.
 *
 * 이 화면만 RFQ 문서번호(KMS-RFQ-2608-027)를 적고 있었다. 나머지는 전부 P-001/S-001
 * 로 부른다(진행현황·대시보드·전역검색·문서·미수·품목분류). 한 프로젝트가 화면마다
 * 다른 이름으로 불리면 같은 것인지 알아보는 일이 사람 몫이 된다.
 *
 * 번호에 붙은 (yymmdd) 는 칩에서 뗀다 — 칩이 답할 것은 '어느 프로젝트인가'까지고,
 * 날짜·문서번호·고객·선박은 마우스를 올리면 나온다. RFQ 번호도 거기서 함께 준다:
 * 버릴 값이 아니라(문서에 찍히고 메일에 오르내린다) 칩에 적을 값이 아닐 뿐이다.
 * 번호가 아직 없는 딜은 문서번호로, 그것도 없으면 줄표로 물러선다.
 */
const chipNo = (d: ShipDeal) => (d.project_no || d.rfq_no || "—").replace(/\s*\(.*$/, "");

/** 칩 하나가 무엇인지 한 줄로 — 번호·고객·선박·제목. */
const dealLabel = (d: ShipDeal) =>
  [d.project_no, d.customer, d.vessel, d.title].filter(Boolean).join(" · ");

function money(v: number | null | undefined, cur: string) {
  if (v == null) return "—";
  const n = Math.round(v);
  return `${cur === "KRW" ? "₩" : cur === "USD" ? "$" : cur + " "}${n.toLocaleString()}`;
}

export default function ShipMapTab() {
  const { data, error, refresh } = useCachedData<ShipMap>("item:ship-map", fetchItemShipMap);
  const [hint, setHint] = useState<Hint>(null);
  const [panel, setPanel] = useState<Panel>(null);
  // 프로젝트가 걸린 계통만 볼 것인가 — 배가 커질수록 빈 칸이 화면을 먹는다.
  const [busyOnly, setBusyOnly] = useState(false);

  // 펴 둔 판은 Esc 로도 닫힌다 — 어디를 눌러야 닫히는지 모를 때의 퇴로.
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  const model: ShipModel | null = useMemo(() => {
    if (!data) return null;
    const cats = data.categories;
    const byId = new Map<number, Cat>(cats.map((c) => [c.id, c]));
    const kids = new Map<number | null, Cat[]>();
    for (const c of cats) {
      const arr = kids.get(c.parent_id ?? null) ?? [];
      arr.push(c);
      kids.set(c.parent_id ?? null, arr);
    }
    for (const arr of kids.values()) arr.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

    // 품목은 가장 깊은 노드에 달려 있다. 계통이 제 것으로 세는 건 그 아래 전부다 —
    // 'Engine Room 68' 은 그 밑 모든 소분류의 합이어야 사람이 읽는 뜻과 같아진다.
    const direct = new Map<number, ShipItem[]>();
    const loose: ShipItem[] = [];
    for (const it of data.items) {
      if (it.category_id == null || !byId.has(it.category_id)) {
        loose.push(it);
        continue;
      }
      const arr = direct.get(it.category_id) ?? [];
      arr.push(it);
      direct.set(it.category_id, arr);
    }
    const roll = new Map<number, ShipItem[]>();
    const gather = (id: number): ShipItem[] => {
      const hit = roll.get(id);
      if (hit) return hit;
      const out = [...(direct.get(id) ?? [])];
      for (const k of kids.get(id) ?? []) out.push(...gather(k.id));
      roll.set(id, out);
      return out;
    };
    for (const c of cats) gather(c.id);

    // 카드가 흘러 들어가는 순서 = 배를 읽는 순서(선교·상부 → 갑판 → 기관 → 부두).
    const roots = (kids.get(null) ?? [])
      .filter((c) => c.active)
      .sort((a, b) => berthOf(a.name) - berthOf(b.name) || a.sort_order - b.sort_order || a.id - b.id);

    // 옮겨 갈 수 있는 자리 — 화면에 선 순서 그대로 훑어 내려가며 경로를 쌓는다.
    // 잎만 담지 않는다: 품목은 지금도 2단(Deck Machinery > Crane)에 걸린 것이 있고,
    // 어느 소분류인지 아직 모를 때 중간에 걸어 두는 것이 미분류로 두는 것보다 낫다.
    const places: { id: number; path: string }[] = [];
    const walk = (c: Cat, prefix: string) => {
      const path = prefix ? `${prefix} > ${c.name}` : c.name;
      places.push({ id: c.id, path });
      for (const k of kids.get(c.id) ?? []) if (k.active) walk(k, path);
    };
    for (const r of roots) walk(r, "");

    const marks = new Map<number, VendorMark[]>();
    for (const v of data.vendor_marks ?? []) {
      if (!byId.has(v.category_id)) continue;   // 지워진 분류에 남은 태그는 안 그린다
      const arr = marks.get(v.category_id) ?? [];
      arr.push(v);
      marks.set(v.category_id, arr);
    }
    return { kids, roll, roots, loose, places, marks };
  }, [data]);

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data || !model) return <div className="state">Loading the ship…</div>;

  // 딜을 통째로 들고 다닌다 — 칩은 번호만 적지만 마우스를 올리면 고객·선박까지 말해야 한다.
  const dealsOf = (items: ShipItem[]) => {
    const seen = new Map<string, { deal: ShipDeal; items: ShipItem[] }>();
    for (const it of items) {
      for (const d of it.deals) {
        const e = seen.get(d.rfq_no) ?? { deal: d, items: [] };
        e.items.push(it);
        seen.set(d.rfq_no, e);
      }
    }
    // 최근 것이 앞에. 프로젝트 번호는 Parts(P)·Service(S) 가 각자 세는 두 계열이라
    // 번호끼리 견주면 시간순이 되지 않는다(S-001 이 P-050 뒤에 선다). 수신일로 세우고
    // 같은 날이면 번호가 뒤를 가른다.
    return Array.from(seen.values()).sort((a, b) =>
      (b.deal.date || "").localeCompare(a.deal.date || "")
      || (b.deal.project_no || "").localeCompare(a.deal.project_no || ""));
  };

  /** 올리면 뜨는 한 줄 — 그 자리가 무엇인지만. */
  const spot = (text: string) => ({
    onMouseEnter: (e: React.MouseEvent) => setHint({ text, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setHint(null),
  });

  /**
   * 누르면 펴지는 판. 빈 자리는 열지 않는다 — 아무것도 답하지 않는 판이 뜨면 누른 사람은
   * 자기가 잘못 눌렀는지 화면이 고장 났는지 알 수 없다.
   * 링크 위에 얹을 때는(프로젝트 칩) 기본 이동을 막되, 새 탭으로 열려는 손짓
   * (Ctrl·Cmd·Shift)은 건드리지 않고 그대로 흘려보낸다.
   */
  const opens = (
    title: React.ReactNode, sub: React.ReactNode, items: ShipItem[],
    href?: string, dealId?: number,
  ) => ({
    onClick: (e: React.MouseEvent) => {
      if (!items.length) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (href) e.preventDefault();
      setHint(null);
      setPanel({ title, sub, items, href, dealId, x: e.clientX, y: e.clientY });
    },
  });

  const totals = {
    items: data.items.length,
    stowed: data.items.filter((i) => i.category_id != null).length,
    deals: new Set(data.items.flatMap((i) => i.deals.map((d) => d.rfq_no))).size,
  };

  return (
    <div className="ship-view" onMouseLeave={() => setHint(null)}>
      <div className="ship-hdr">
        <div>
          {/* 제목은 탭 이름(Ship View)을 되풀이하지 않는다. 이 앱은 진짜 선박도 관리하므로
              (Settings · Vessels, 딜마다 붙는 선명) 'Ship View' 만 크게 적혀 있으면 어느
              배의 화면인가로 읽힌다. 여기 실린 것은 배가 아니라 품목 분류다 — 배는 그
              분류를 눕혀 놓는 자리일 뿐이라, 제목은 실린 것을 말하고 배는 탭이 말한다. */}
          <h2>Item categories on board</h2>
          <p className="hint-inline">
            The whole classification laid out as one vessel — every category, where it sits on
            board, and which projects are hanging on it. Hover a category or a project number to
            read the items behind it. No real vessel is involved; the decks are just where each
            group of categories belongs.
          </p>
        </div>
        <div className="ship-stats">
          <span><b>{totals.stowed}</b> of {totals.items} items stowed</span>
          <span><b>{totals.deals}</b> projects on board</span>
          <label className="ship-toggle">
            <input type="checkbox" checked={busyOnly} onChange={(e) => setBusyOnly(e.target.checked)} />
            Only where something is stowed
          </label>
        </div>
      </div>

      {/* 판에는 그림을 깔지 않는다 — 선체 윤곽·마스트·굴뚝·흘수선은 아무 값도 나르지
          않으면서 카드 뒤에서 색을 흔들었다. 배는 갑판 이름(선교·갑판·기관·부두)이
          말하고, 화면은 그 자리에 실린 숫자만 그린다. */}
      <div className="ship-board">
        {/* 세 단에 카드를 흘려 넣는다 — 칸을 미리 잘라 계통을 배정하지 않는다.
            부피가 계통마다 열 배씩 다르므로(기관실 77건 vs 선교 0건) 자리를 못 박으면
            한 칸은 넘쳐서 스크롤하고 옆 칸은 절반이 빈다. 단 높이는 브라우저가 맞추고,
            카드는 갑판 순서(선교→갑판→기관→부두)대로 흘러 들어간다. */}
        <div className="ship-grid">
          {model.roots
            .filter((r) => !busyOnly || (model.roll.get(r.id) ?? []).length)
            .map((z) => (
              <Zone
                key={z.id}
                cat={z}
                model={model}
                busyOnly={busyOnly}
                dealsOf={dealsOf}
                spot={spot}
                opens={opens}
              />
            ))}
        </div>
      </div>

      {/* 아직 배에 싣지 못한 품목 — 분류가 없어 자리를 못 잡은 것들. 감추면 영영 안 는다. */}
      {model.loose.length || data.unmatched ? (
        <div className="ship-dock">
          <div className="ship-dock-tag">Not stowed yet</div>
          <div className="ship-dock-body">
            {model.loose.length ? (
              <button
                type="button"
                className="ship-chip ship-chip--loose"
                {...spot(`${model.loose.length} item(s) with no category yet`)}
                {...opens("Unclassified", "no category assigned yet", model.loose)}
              >
                {model.loose.length} item(s) with no category
              </button>
            ) : null}
            {data.unmatched ? (
              <span className="hint-inline">
                {data.unmatched} price line(s) are not linked to any item master — they are listed
                under Item Category · Unmatched.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {hint ? <Hinter hint={hint} /> : null}
      {panel ? (
        <Peeker
          panel={panel}
          places={model.places}
          onClose={() => setPanel(null)}
          /**
           * 자리를 옮긴 뒤 — 판은 열어 둔 채 그 줄만 새 자리로 고쳐 준다.
           * 옮길 때마다 판이 닫히면 잘못 실린 품목 서넛을 잇달아 바로잡을 수 없고,
           * 판을 그대로 두면 방금 고친 줄이 옛 자리를 그대로 말한다.
           * 뒤에 선 배(카드의 숫자·프로젝트 칩)는 다시 받아 온 자료로 맞춰진다 —
           * 품목표·분류 화면도 같은 자료를 보므로 그쪽 캐시까지 비운다.
           */
          onMoved={(itemId, categoryId) => {
            setPanel((p) => (p ? {
              ...p,
              items: p.items.map((it) =>
                it.item_id === itemId ? { ...it, category_id: categoryId } : it),
            } : p));
            invalidateCache("item:");
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 계통 옆에 서는 거래선 — 로고가 있으면 로고, 없으면 색 이니셜.
 *
 * 근거의 세기를 모양으로 가른다. 셋을 같은 무게로 세우면 "여기서 사 봤다"와 "여기에
 * 물어볼 수는 있다"가 구별되지 않는데, 그 차이가 곧 이 마크를 보는 이유다.
 *   supplied  실제로 발주한 곳 — 온전한 색
 *   quoted    값을 준 곳(사지 않았어도) — 한 겹 옅게
 *   listed    다룬다고 밝혀만 둔 곳 — 가장 옅고 테두리가 점선
 * 무엇을 근거로 섰는지는 마우스를 올리면 나온다(why).
 *
 * 넘치는 것은 CSS 가 한 줄로 자른다 — 개수를 미리 잘라 "+N" 으로 접으면 넓은 화면에서
 * 자리가 남는데도 늘 세 개에서 멈춘다. 센 근거부터 오므로 잘리는 쪽은 늘 약한 쪽이다.
 */
function VendorPins({ marks }: { marks: VendorMark[] }) {
  const logoFor = useVendorLogo();
  if (!marks.length) return null;
  return (
    <span className="ship-pins">
      {marks.map((v) => {
        const logo = logoFor(v.name);
        const cls = `ship-pin ship-pin--${v.tier}`;
        const title = `${v.name} — ${v.why}`;
        return logo ? (
          <img key={v.name} className={cls} src={logo} alt="" title={title} />
        ) : (
          <span key={v.name} className={`${cls} ship-pin--mono`}
                style={{ ["--h" as string]: hueOf(v.name) }} title={title}>
            {initialsOf(v.name)}
          </span>
        );
      })}
    </span>
  );
}

/** 이름 → 1~2글자 이니셜(VendorMonograms 와 같은 규칙 — 같은 회사는 어디서나 같게). */
function initialsOf(name: string): string {
  const w = name.replace(/[()[\]]/g, " ").split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return w.length === 1 ? w[0].slice(0, 2).toUpperCase() : (w[0][0] + w[1][0]).toUpperCase();
}

/** 이름 → 늘 같은 색. */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** 대분류 한 칸 — 배 위의 한 구역. 그 아래 중·소분류와 프로젝트 번호가 모두 들어간다. */
function Zone({
  cat, model, busyOnly, dealsOf, spot, opens,
}: {
  cat: Cat;
  model: ShipModel;
  busyOnly: boolean;
  dealsOf: (items: ShipItem[]) => { deal: ShipDeal; items: ShipItem[] }[];
  spot: (text: string) => {
    onMouseEnter: (e: React.MouseEvent) => void;
    onMouseLeave: () => void;
  };
  opens: (
    title: React.ReactNode, sub: React.ReactNode, items: ShipItem[],
    href?: string, dealId?: number,
  ) => { onClick: (e: React.MouseEvent) => void };
}) {
  const mine = model.roll.get(cat.id) ?? [];
  const subs = (model.kids.get(cat.id) ?? []).filter((c) => c.active);
  const deals = dealsOf(mine);
  const shown = busyOnly ? subs.filter((s) => (model.roll.get(s.id) ?? []).length) : subs;

  const deck = DECKS[berthOf(cat.name)];

  return (
    <article
      className={`ship-zone${mine.length ? "" : " ship-zone--empty"}`}
      /* 색은 카드가 아니라 갑판의 것이다 — 같은 구역 카드끼리 한 계열로 묶여야 세 단에
         흩어져 놓여도 "이 셋은 한 구역"이 먼저 읽힌다. 자리(열)는 부피가 정하므로
         구역을 자리로는 말할 수 없고, 남는 수단이 색이다. */
      data-deck={berthOf(cat.name)}
    >
      {/* 갑판 이름표는 카드 안에 있다 — 카드가 어느 단에 놓이든 제자리를 말하도록. */}
      <div className="ship-zone-deck"><b>{deck.name}</b><span>{deck.sub}</span></div>
      <header
        {...spot(`${cat.name} — ${mine.length} item(s) on this system`)}
        {...opens(cat.name, `${mine.length} item(s) on this system`, mine)}
      >
        <Mark name={cat.name} />
        <h3>{cat.name}</h3>
        {/* 계통 전체를 다룬다고 적어 둔 거래선 — 대분류에 직접 달린 태그만 선다.
            아래 중분류의 마크를 여기로 끌어올리면 큰 계통 하나가 스무 개를 달게 된다. */}
        <VendorPins marks={model.marks.get(cat.id) ?? []} />
        <span className="ship-zone-n">{mine.length}</span>
      </header>

      {deals.length ? (
        <div className="ship-projects">
          {deals.map(({ deal, items }) => {
            const href = `/project?rfq=${deal.rfq_id}&view=overview&back=${encodeURIComponent("/item")}`;
            return (
              <Link
                key={deal.rfq_no}
                className="ship-proj"
                href={href}
                {...spot(dealLabel(deal))}
                {...opens(
                  <ProjectNo value={deal.project_no || deal.rfq_no} />,
                  <>
                    {/* 누구의 무슨 배인가와, 여기 몇 건이 걸렸는가는 다른 이야기다 —
                        한 줄에 붙여 놓으면 긴 고객명 뒤에 숫자가 묻힌다. */}
                    <span>{[deal.customer, deal.vessel].filter(Boolean).join(" · ")}</span>
                    <span>— {items.length} item(s) on {cat.name}</span>
                  </>,
                  items,
                  href,
                  deal.rfq_id,
                )}
              >
                {chipNo(deal)}
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="ship-projects ship-projects--none">no project yet</div>
      )}

      {/* 계열이 많은 카드(기관실)는 소분류를 두 단으로 접는다 — 한 줄로 세우면 카드
          하나가 다른 카드 서너 장 높이가 되어 화면의 균형이 그 카드 하나로 결정된다. */}
      <div className={`ship-subs${shown.length > WIDE_SUBS ? " ship-subs--two" : ""}`}>
        {shown.map((s) => {
          const items = model.roll.get(s.id) ?? [];
          const leaves = (model.kids.get(s.id) ?? []).filter((c) => c.active);
          return (
            <div className={`ship-sub${items.length ? "" : " ship-sub--empty"}`} key={s.id}>
              <div
                className="ship-sub-hd"
                {...spot(`${cat.name} · ${s.name} — ${items.length} item(s)`)}
                {...opens(s.name, `${cat.name} · ${items.length} item(s)`, items)}
              >
                <span>{s.name}</span>
                <VendorPins marks={model.marks.get(s.id) ?? []} />
                <b>{items.length}</b>
              </div>
              {leaves.length ? (
                <div className="ship-leaves">
                  {(busyOnly ? leaves.filter((l) => (model.roll.get(l.id) ?? []).length) : leaves)
                    .map((l) => {
                      const li = model.roll.get(l.id) ?? [];
                      return (
                        <span
                          key={l.id}
                          className={`ship-leaf${li.length ? "" : " ship-leaf--empty"}`}
                          {...spot(`${s.name} > ${l.name} — ${li.length} item(s)`)}
                          {...opens(l.name, `${cat.name} > ${s.name}`, li)}
                        >
                          {l.name}
                          {li.length ? <b>{li.length}</b> : null}
                        </span>
                      );
                    })}
                </div>
              ) : null}
            </div>
          );
        })}
        {!shown.length ? <div className="ship-sub ship-sub--empty">no sub-category</div> : null}
      </div>
    </article>
  );
}

/**
 * 가격 뒤에 붙는 출처 — 그 숫자가 실려 온 문서(견적·발주·인보이스)와 번호.
 * 프로젝트 번호(KMS-RFQ-…)는 '어느 딜인가'까지만 말한다. 매입가·매출가·마진을 낳은
 * 것은 그 딜 안의 문서라, 숫자를 되짚으려면 문서 이름이 숫자 옆에 있어야 한다.
 * 번호는 수동 입력이라 비어 있을 수 있고, 그때는 문서 이름만 남는다.
 */
function Src({ doc }: { doc?: { kind: string; no: string } | null }) {
  if (!doc?.kind) return null;
  return <span className="ship-peek-src"> · {doc.no ? `${doc.kind} ${doc.no}` : doc.kind}</span>;
}

/**
 * 품목 한 줄에 붙는 프로젝트 번호 — 이 품목이 어느 건에서 나왔는가.
 *
 * 계통에서 편 판(Engine Room·Main Engine System…)에서는 줄마다 다른 건이 서므로 이
 * 번호가 그 줄의 출처를 말하는 유일한 값이다. 그런데 프로젝트 칩에서 편 판에서는
 * 실린 품목이 전부 그 프로젝트의 것이라 같은 번호가 줄 수만큼 되풀이된다 — 아무것도
 * 답하지 않으면서, 그 품목이 함께 걸린 다른 건까지 그 반복 속에 묻는다.
 * 그래서 판을 연 그 프로젝트만 빼고 나머지를 보인다. 남는 것이 없으면 줄도 없다.
 */
function ItemDeals({ deals, except }: { deals: ShipDeal[]; except?: number }) {
  const MAX = 4;
  const rest = except != null ? deals.filter((d) => d.rfq_id !== except) : deals;
  if (!rest.length) return null;
  return (
    <div className="ship-peek-d">
      {rest.slice(0, MAX).map((d) => (
        <span
          key={d.rfq_id}
          title={[dealLabel(d), d.date, `${d.lines} line(s)`].filter(Boolean).join(" · ")}
        >
          {chipNo(d)}
        </span>
      ))}
      {rest.length > MAX ? <span>+{rest.length - MAX}</span> : null}
    </div>
  );
}

/** 마우스를 따라 뜨는 한 줄 — 그 자리가 무엇인지만. 마우스를 먹지 않는다. */
function Hinter({ hint }: { hint: NonNullable<Hint> }) {
  const w = 340;
  const left = typeof window !== "undefined" && hint.x + w + 20 > window.innerWidth
    ? Math.max(8, hint.x - w - 12)
    : hint.x + 14;
  const top = typeof window !== "undefined"
    ? Math.min(hint.y + 18, Math.max(8, window.innerHeight - 60))
    : hint.y + 18;
  return <div className="ship-hint" style={{ left, top, maxWidth: w }}>{hint.text}</div>;
}

/**
 * 품목 한 줄의 자리를 고르는 칸 — '대 > 중 > 소' 전체 경로 목록.
 *
 * 고른 값이 곧 저장이다(따로 확인 단추를 두지 않는다). 자리를 고르는 일은 한 번에
 * 끝나는 손짓이고, 되돌리는 길은 같은 자리에서 다시 고르는 것이라 확인을 한 겹
 * 더 두면 손만 늘어난다. 잘못 눌렀을 때의 퇴로는 Cancel 이다.
 *
 * 'Unclassified' 를 목록 맨 위에 남긴다 — 자리를 잘못 잡은 것을 알겠는데 어디로
 * 보낼지는 아직 모를 때, 배에서 내려놓는 것이 엉뚱한 계통에 실어 두는 것보다 낫다
 * (미분류는 Item Category 탭이 따로 세어 보여 준다).
 */
function PlacePicker({ places, current, saving, failed, onPick, onCancel }: {
  places: { id: number; path: string }[];
  current: number | null;
  saving: boolean;
  failed: string | null;
  onPick: (categoryId: number | null) => void;
  onCancel: () => void;
}) {
  return (
    <div className="ship-peek-mvbox">
      <select
        className="ship-peek-mvsel"
        defaultValue={current == null ? "" : String(current)}
        disabled={saving}
        autoFocus
        onChange={(e) => onPick(e.target.value === "" ? null : Number(e.target.value))}
      >
        <option value="">— Unclassified</option>
        {places.map((pl) => (
          <option key={pl.id} value={pl.id}>{pl.path}</option>
        ))}
      </select>
      <button type="button" className="ship-peek-mvx" onClick={onCancel} disabled={saving}>
        {saving ? "Saving…" : "Cancel"}
      </button>
      {/* 실패는 그 줄에 남는다 — 판이 닫히면 무엇을 옮기려다 실패했는지가 함께 사라진다. */}
      {failed ? <span className="ship-peek-mverr">{failed}</span> : null}
    </div>
  );
}

/**
 * 눌러서 펴는 판 — 그 자리에 걸린 품목을 자세히. 이제 마우스를 따라 스치듯 뜨는 것이
 * 아니라 누른 자리에 머무르므로, 마우스를 먹고(안의 링크를 누를 수 있어야 한다) 닫는
 * 길을 세 갈래로 둔다: 판 밖 아무 곳, 닫기 단추, Esc.
 */
function Peeker({ panel, places, onClose, onMoved }: {
  panel: NonNullable<Panel>;
  places: { id: number; path: string }[];
  onClose: () => void;
  onMoved: (itemId: number, categoryId: number | null) => void;
}) {
  const MAX = 8;
  /**
   * 자리를 고치는 줄 — 한 번에 하나만 연다(열어 둔 select 가 여럿이면 어느 것을
   * 저장하는 중인지 알 수 없다). null 이면 아무 줄도 고치는 중이 아니다.
   *
   * 이 판이 잘못 실린 품목이 눈에 띄는 자리라서 여기서 고칠 수 있어야 한다 —
   * 'Shore crane service ...' 가 Engine Room > Fuel Oil System > Service Tank 에
   * 실려 있는 것은 여기서 보이는데, 고치러 가려면 Item Category 탭으로 건너가
   * 그 품목을 다시 찾아야 했다.
   */
  const [editing, setEditing] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // 처음에는 여덟만 편다 — 스물셋이 통째로 들어오면 첫 화면이 목록에 잠긴다. 다만
  // 접어 둔 나머지를 세어 보이기만 하고 펼 길이 없으면 그 수는 알림이 아니라 벽이다.
  const [all, setAll] = useState(false);
  // 다른 자리를 눌러 판이 바뀌면 다시 접는다(판마다 처음은 여덟이어야 한다).
  useEffect(() => setAll(false), [panel]);
  // 판을 옮겨 다니는 동안 고치던 줄이 따라다니지 않도록 — 판이 바뀌면 함께 접는다.
  useEffect(() => { setEditing(null); setFailed(null); }, [panel.title, panel.sub]);
  const shown = all ? panel.items : panel.items.slice(0, MAX);
  const rest = panel.items.length - MAX;
  // 화면 밖으로 나가지 않게 — 오른쪽·아래로 넘칠 자리면 반대편에 붙인다.
  const w = 420;
  const left = typeof window !== "undefined" && panel.x + w + 24 > window.innerWidth
    ? Math.max(12, panel.x - w - 16)
    : panel.x + 16;
  // 판이 화면 밖으로 흘러나가면 아래가 잘린다 — 앞서 품목 셋째 줄과 프로젝트로 가는
  // 길이 그렇게 사라졌다. CSS 의 max-height 와 같은 값으로 위치를 잡아 바닥이 늘 화면
  // 안에 서게 한다(넘치는 것은 목록이 스스로 구른다).
  const maxH = typeof window !== "undefined" ? Math.min(window.innerHeight * 0.72, 460) : 460;
  const top = typeof window !== "undefined"
    ? Math.min(Math.max(12, panel.y - 40), Math.max(12, window.innerHeight - maxH - 12))
    : panel.y;
  return (
    <>
      {/* 판 밖 아무 데나 눌러도 닫힌다 — 닫기 단추를 찾아 마우스를 옮기지 않도록. */}
      <div className="ship-peek-veil" onClick={onClose} />
      <div className="ship-peek" style={{ left, top, width: w }}>
      <div className="ship-peek-hd">
        <b>{panel.title}</b>
        <span>{panel.sub}</span>
        <button type="button" className="ship-peek-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <ul>
        {shown.map((it) => (
          <li key={it.item_id}>
            {/* 번호는 품목의 신원에 딸린 값이다 — 이 줄이 어느 건에서 나왔는가. 값(매입·
                매출) 뒤에 두면 품명과 번호 사이에 금액 두 줄이 끼어, 무엇이 어느 건 것인지
                되짚으려면 눈이 위아래로 오간다. 이름 옆에 붙여 한 번에 읽히게 한다. */}
            <div className="ship-peek-t">
              {it.part_no ? <code>{it.part_no}</code> : null}
              <span>{it.description || "(no description)"}</span>
              <ItemDeals deals={it.deals} except={panel.dealId} />
            </div>
            {/* 상대는 금액 줄 안에 있어야 한다 — 산 값에는 판 쪽이, 판 값에는 산 쪽이
                붙는다. 앞서는 넷을 한 줄에 나란히 흘려 놓아, 줄바꿈이 어디서 걸리느냐에
                따라 공급사가 판매가 옆에 서곤 했다(판 적 없는 곳에 판 것처럼 읽혔다). */}
            <div className="ship-peek-m">
              {it.maker ? <span className="ship-peek-mk">{it.maker}</span> : null}
              {it.buy ? (
                <span className="ship-peek-p">
                  buy {money(it.buy.unit_price, it.buy.currency)}
                  <Src doc={it.buy.doc} />
                  {it.buy.party ? <span className="ship-peek-pt"> ← {it.buy.party}</span> : null}
                </span>
              ) : null}
              {it.sell ? (
                <span className="ship-peek-p">
                  sell {money(it.sell.unit_price, it.sell.currency)}
                  <Src doc={it.sell.doc} />
                  {it.sell.party ? <span className="ship-peek-pt"> → {it.sell.party}</span> : null}
                </span>
              ) : null}
              {/* 마진은 늘 제 줄에 선다. 매출 줄 꼬리에 붙여 두면 줄 길이에 따라 어떤
                  품목은 그 줄 끝에, 어떤 품목은 다음 줄로 넘어가 — 품목 여럿을 위아래로
                  견줄 때 눈이 매번 다른 자리에서 숫자를 찾아야 했다. */}
              {it.margin_pct != null ? <span className="ship-peek-mg">{it.margin_pct}%</span> : null}
              {/* 자리를 고치는 손잡이 — 값(매입·매출·마진)을 다 읽은 뒤 맨 끝에 선다.
                  평소에는 옅게 물러나 있다가 그 줄에 마우스를 올리면 또렷해진다:
                  판은 읽는 자리가 먼저고 고치는 자리는 그 다음이다. */}
              {editing === it.item_id ? null : (
                <button
                  type="button"
                  className="ship-peek-mv"
                  onClick={() => { setEditing(it.item_id); setFailed(null); }}
                >
                  {it.category_id == null ? "Classify…" : "Move…"}
                </button>
              )}
            </div>
            {editing === it.item_id ? (
              <PlacePicker
                places={places}
                current={it.category_id}
                saving={saving}
                failed={failed}
                onCancel={() => { setEditing(null); setFailed(null); }}
                onPick={async (cid) => {
                  if (cid === it.category_id) { setEditing(null); return; }
                  setSaving(true);
                  setFailed(null);
                  try {
                    await assignItemLedgerCategory({ item_id: it.item_id, category_id: cid });
                    onMoved(it.item_id, cid);
                    setEditing(null);
                  } catch (e) {
                    setFailed(e instanceof Error ? e.message : String(e));
                  } finally {
                    setSaving(false);
                  }
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" className="ship-peek-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show first 8" : `+${rest} more item(s)`}
        </button>
      ) : null}
      {/* 프로젝트에서 편 판이면 그 프로젝트로 가는 길을 남긴다 — 칩을 누르면 판이 뜨게
          되었으므로, 예전처럼 눌러서 바로 넘어가던 길이 여기 대신 서야 한다. */}
      {panel.href ? (
        <Link className="ship-peek-go" href={panel.href}>Open this project →</Link>
      ) : null}
      </div>
    </>
  );
}
