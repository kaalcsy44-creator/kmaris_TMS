"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fetchItemShipMap } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { ShipDeal, ShipItem, ShipMap } from "@/lib/types";

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

/** 화면이 쓰는 모양으로 한 번 갈아 둔 트리 — 부모·자식, 분류별 품목, 롤업. */
type ShipModel = {
  kids: Map<number | null, Cat[]>;
  roll: Map<number, ShipItem[]>;   // 그 분류와 그 아래 전부의 품목
  roots: Cat[];
  loose: ShipItem[];               // 분류가 없어 배에 못 실은 품목
};

/** 마우스가 올라간 자리에 펼칠 내역 — 무엇의 내역인지(제목)와 그 품목들. */
type Peek = {
  title: string;
  sub: string;
  items: ShipItem[];
  x: number;
  y: number;
} | null;

function berthOf(name: string): number {
  const k = (name || "").trim().toUpperCase();
  return BERTH[k] ?? DECKS.length - 1;   // 모르는 계통은 부두에 내려놓는다.
}

/**
 * 칩에 적는 프로젝트 번호 — 앞머리(KMS-RFQ-)를 뗀다.
 *
 * 번호 자체는 그대로 둘 값이다. 이 화면에서 프로젝트를 여는 열쇠이고, 연·월·일련이라
 * 정렬이 곧 시간순이며, 사람들이 실제로 이 번호로 서로에게 말한다. 문제는 길이다 —
 * 기관실 한 칸에 열두 개가 서면 서로 다른 곳은 뒤 두 마디뿐인데 같은 앞머리가 칸의
 * 절반을 먹고, 그 줄들이 정작 이 카드의 본문(계통과 숫자)을 아래로 밀어낸다.
 * 그래서 칩에는 구별되는 부분만 적고, 온전한 번호와 고객·선박은 마우스를 올릴 때 준다.
 * 번호는 수동 입력이라 이 꼴이 아닐 수도 있는데, 그때는 손대지 않고 그대로 적는다.
 */
const shortNo = (no: string) => no.replace(/^KMS-RFQ-/i, "");

/** 칩 하나가 무엇인지 한 줄로 — 온전한 번호에 고객·선박·제목을 잇는다. */
const dealLabel = (d: ShipDeal) =>
  [d.rfq_no, d.customer, d.vessel, d.title].filter(Boolean).join(" · ");

function money(v: number | null | undefined, cur: string) {
  if (v == null) return "—";
  const n = Math.round(v);
  return `${cur === "KRW" ? "₩" : cur === "USD" ? "$" : cur + " "}${n.toLocaleString()}`;
}

export default function ShipMapTab() {
  const { data, error } = useCachedData<ShipMap>("item:ship-map", fetchItemShipMap);
  const [peek, setPeek] = useState<Peek>(null);
  // 프로젝트가 걸린 계통만 볼 것인가 — 배가 커질수록 빈 칸이 화면을 먹는다.
  const [busyOnly, setBusyOnly] = useState(false);

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
    return { kids, roll, roots, loose };
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
    // 번호는 연도·월·일련이 그대로 정렬이 된다 — 최근 것이 앞에 서도록 내림차순.
    return Array.from(seen.values()).sort((a, b) => b.deal.rfq_no.localeCompare(a.deal.rfq_no));
  };

  // 마우스를 올리면 펴고 떼면 접는다 — 두 손잡이를 한 벌로 묶어 두면 붙이는 자리마다
  // 짝이 어긋나지 않는다(한쪽만 붙으면 내역이 화면에 눌어붙는다).
  const hover = (title: string, sub: string, items: ShipItem[]) => ({
    onMouseEnter: (e: React.MouseEvent) =>
      setPeek(items.length ? { title, sub, items, x: e.clientX, y: e.clientY } : null),
    onMouseLeave: () => setPeek(null),
  });

  const totals = {
    items: data.items.length,
    stowed: data.items.filter((i) => i.category_id != null).length,
    deals: new Set(data.items.flatMap((i) => i.deals.map((d) => d.rfq_no))).size,
  };

  return (
    <div className="ship-view" onMouseLeave={() => setPeek(null)}>
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
                hover={hover}
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
                {...hover("Unclassified", "no category assigned yet", model.loose)}
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

      {peek ? <Peeker peek={peek} /> : null}
    </div>
  );
}

/** 대분류 한 칸 — 배 위의 한 구역. 그 아래 중·소분류와 프로젝트 번호가 모두 들어간다. */
function Zone({
  cat, model, busyOnly, dealsOf, hover,
}: {
  cat: Cat;
  model: ShipModel;
  busyOnly: boolean;
  dealsOf: (items: ShipItem[]) => { deal: ShipDeal; items: ShipItem[] }[];
  hover: (title: string, sub: string, items: ShipItem[]) => {
    onMouseEnter: (e: React.MouseEvent) => void;
    onMouseLeave: () => void;
  };
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
      <header {...hover(cat.name, `${mine.length} item(s) on this system`, mine)}>
        <Mark name={cat.name} />
        <h3>{cat.name}</h3>
        <span className="ship-zone-n">{mine.length}</span>
      </header>

      {deals.length ? (
        <div className="ship-projects">
          {deals.map(({ deal, items }) => (
            <Link
              key={deal.rfq_no}
              className="ship-proj"
              href={`/project?rfq=${deal.rfq_id}&view=overview&back=${encodeURIComponent("/item")}`}
              title={dealLabel(deal)}
              {...hover(
                deal.rfq_no,
                [[deal.customer, deal.vessel].filter(Boolean).join(" · "),
                 `${items.length} item(s) on ${cat.name}`].filter(Boolean).join(" — "),
                items,
              )}
            >
              {shortNo(deal.rfq_no)}
            </Link>
          ))}
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
                {...hover(s.name, `${cat.name} · ${items.length} item(s)`, items)}
              >
                <span>{s.name}</span>
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
                          {...hover(l.name, `${cat.name} > ${s.name}`, li)}
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

/** 마우스를 따라다니는 내역 — 그 자리에 걸린 품목을 자세히 편다. */
function Peeker({ peek }: { peek: NonNullable<Peek> }) {
  const MAX = 8;
  const rest = peek.items.length - MAX;
  // 화면 밖으로 나가지 않게 — 오른쪽·아래로 넘칠 자리면 반대편에 붙인다.
  const w = 420;
  const left = typeof window !== "undefined" && peek.x + w + 24 > window.innerWidth
    ? Math.max(12, peek.x - w - 16)
    : peek.x + 16;
  const top = typeof window !== "undefined"
    ? Math.min(Math.max(12, peek.y - 40), Math.max(12, window.innerHeight - 340))
    : peek.y;
  return (
    <div className="ship-peek" style={{ left, top, width: w }}>
      <div className="ship-peek-hd">
        <b>{peek.title}</b>
        <span>{peek.sub}</span>
      </div>
      <ul>
        {peek.items.slice(0, MAX).map((it) => (
          <li key={it.item_id}>
            <div className="ship-peek-t">
              {it.part_no ? <code>{it.part_no}</code> : null}
              <span>{it.description || "(no description)"}</span>
            </div>
            <div className="ship-peek-m">
              {it.maker ? <span>{it.maker}</span> : null}
              {it.buy ? <span>buy {money(it.buy.unit_price, it.buy.currency)}<Src doc={it.buy.doc} /></span> : null}
              {it.sell ? <span>sell {money(it.sell.unit_price, it.sell.currency)}<Src doc={it.sell.doc} /></span> : null}
              {it.margin_pct != null ? <span className="ship-peek-mg">{it.margin_pct}%</span> : null}
              {it.vendor ? <span>← {it.vendor}</span> : null}
              {it.customer ? <span>→ {it.customer}</span> : null}
            </div>
            {it.deals.length ? (
              <div className="ship-peek-d">
                {it.deals.slice(0, 4).map((d) => (
                  <span
                    key={d.rfq_id}
                    title={[dealLabel(d), d.date, `${d.lines} line(s)`]
                      .filter(Boolean).join(" · ")}
                  >
                    {shortNo(d.rfq_no)}
                  </span>
                ))}
                {it.deals.length > 4 ? <span>+{it.deals.length - 4}</span> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {rest > 0 ? <div className="ship-peek-more">+{rest} more item(s)</div> : null}
    </div>
  );
}
