"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  addRfqStageNote,
  fetchCustomers,
  fetchMailDigest,
  fetchMailStatus,
  fetchPipeline,
  fetchSettingsVessels,
  refreshMailDigests,
} from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { MailDigestRow, PipelineRow } from "@/lib/types";
import { PipelineModal } from "@/components/screens/ProjectsScreen";
import Modal from "@/components/common/Modal";
import ActivityDesc from "@/components/common/ActivityDesc";
import CustomerName from "@/components/common/CustomerName";
import ProjectNo from "@/components/common/ProjectNo";
import VendorMonograms from "@/components/common/VendorMonograms";
import { buildActivities, daysSinceISO, hm, lastActivityISO, md } from "@/lib/activity";
import { isLabelledRollup, parseRollupLine } from "@/lib/rollup";
import type { Activity } from "@/lib/activity";
import ActivityNoteForm, {
  initialNoteValue,
  noteFormToPatch,
  type ActivityNoteValue,
} from "@/components/common/ActivityNoteForm";
import {
  activityParties,
  activityPersons,
  buildStageChain,
  resolveSteps,
  stageForNote,
  vendorOf,
} from "@/lib/deal";

// Briefing — 아침에 가장 먼저 여는 화면. 프로젝트 하나가 카드 하나다.
//
// 전에는 같은 이야기가 두 군데로 갈라져 있었다. Activity 의 "Latest activity" 팝업은
// **시스템이 기록한 사건**(RFQ Sent · Quote Received · Payment Completed)을 보여 주고,
// Dashboard 의 Mail 탭은 **실제로 오간 말**(메일과 그 요약)을 보여 줬다. 둘은 같은 건의
// 앞뒤 면이라, 나눠 놓으면 "견적을 보냈다"와 "얼마에 보냈고 상대가 뭐라 했나"를 보려고
// 화면을 오가야 했다.
//
// 그래서 한 장으로 합친다. 카드 하나가 위에서 아래로
//   신원(번호·제목·선박·단계) → 상대(고객·담당자·벤더) → 진행바
//   → 지금 상태(공이 누구에게) → AI 요약 → **사건과 메일을 한 시간축에 섞은 최근 줄**
// 순으로 놓인다. 마지막 줄들이 이 화면의 핵심이다 — 사건과 말이 시간순으로 나란히
// 붙어야 무슨 일이 있었는지가 한 번에 읽힌다.
//
// 데이터는 새로 만들지 않는다. 사건은 화면이 이미 가진 pipeline 목록에서 buildActivities
// 가 뽑고(Activity 화면과 같은 함수), 메일은 /mail/digest 집계 하나에서 온다.

type Filter = "all" | "ours" | "theirs" | "nomail";

const DAYS = 14;              // 이 기간 안에 움직인 딜만 카드가 된다
const SHOW_CHOICES = [1, 3, 5, 8];
const COL_CHOICES = [2, 3];
const COLS_KEY = "ktms.brief.cols";

// 카드 한 줄이 되는 것 — 사건이거나 메일이거나. 시간축 하나에 섞어 세운다.
type Line =
  | { at: string; kind: "act"; act: Activity }
  | { at: string; kind: "mail"; dir: "in" | "out"; party: string; text: string };

type Card = {
  row: PipelineRow;
  mail: MailDigestRow | null;
  // 이 딜에 붙은 전체 메일 통수. mail 이 null 이어도 0 이 아닐 수 있다 — 집계 상한에
  // 걸려 이번 응답에 안 실렸을 뿐인 경우다. "메일 없음"을 이 값으로 판단한다.
  mailCount: number;
  lines: Line[];
  lastAt: string;             // 사건·메일 통틀어 마지막 움직임
  waitingDays: number;        // 마지막 메일이 수신인 채 지난 날수(메일 없으면 0)
};

export default function BriefingTab() {
  const { data: digest, error: digestErr, refresh } = useCachedData("mail:digest", () =>
    fetchMailDigest(DAYS));
  const { data: pipeline, error: pipeErr, refresh: refreshPipeline } =
    useCachedData("pipeline", () => fetchPipeline());
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const { data: vessels } = useCachedData("settings:vessels", fetchSettingsVessels);
  // 연동 상태는 카드를 그리는 데 필요하지 않다 — 실패해도 화면은 그대로 나와야 한다.
  const { data: status } = useCachedData("mail:status", () =>
    fetchMailStatus().catch(() => null));

  const [filter, setFilter] = useState<Filter>("all");
  // 두 컨트롤은 서로 다른 질문에 답한다. show 는 "오늘 이 보드를 얼마나 촘촘히 볼까"
  // 라는 밀도이고, expanded 는 "이 건만 더 보여줘"라는 한 건에 대한 요청이다. 한 건이
  // 궁금할 때마다 밀도를 올리면 15장이 다 늘어나 보던 자리를 잃는다.
  const [show, setShow] = useState(3);          // 카드마다 보여 줄 최근 줄 수(기본값)
  const [expanded, setExpanded] = useState<number[]>([]);   // 통째로 편 카드(딜 번호)
  // 열 수 — 3열은 한 화면에 더 많은 딜을 올리고, 2열은 요약 네 줄이 접히지 않아 카드
  // 하나가 그 자리에서 다 읽힌다. 훑는 것보다 읽는 쪽을 기본으로 둔다(요청) — 카드에
  // 실린 게 문장이라, 두세 줄로 접히면 훑기의 이득도 같이 사라진다.
  const [cols, setCols] = useState(2);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [openRfqId, setOpenRfqId] = useState<number | null>(null);
  const [addRfqId, setAddRfqId] = useState<number | null>(null);   // 활동기록 팝업을 연 딜
  const [stageTarget, setStageTarget] = useState<{ stage: number; vrfqId?: number } | null>(null);

  // 고른 열 수는 기억한다. 첫 렌더 뒤에 읽어 서버/클라 첫 그림을 같게 유지한다.
  useEffect(() => {
    try {
      const v = Number(window.localStorage.getItem(COLS_KEY));
      if (v === 2 || v === 3) setCols(v);
    } catch {
      /* 저장소를 못 읽으면 기본값(3열) */
    }
  }, []);
  function pickCols(n: number) {
    setCols(n);
    try {
      window.localStorage.setItem(COLS_KEY, String(n));
    } catch {
      /* 저장 실패는 무시 — 이번 화면에서만 적용된다 */
    }
  }

  const steps = useMemo(() => pipeline?.steps ?? [], [pipeline]);
  const waitingAfter = digest?.waiting_after ?? 2;

  // 카드 목록 = 최근에 **메일이 오갔거나 사건이 있었던** 열린 딜의 합집합.
  // 메일 쪽만 보면 아직 메일이 안 붙은 딜이 통째로 사라지고, 사건 쪽만 보면 사건 없이
  // 메일만 오간 딜이 사라진다. 아침에 놓치면 안 되는 건 그 둘 다이다.
  const cards = useMemo<Card[]>(() => {
    const rows = pipeline?.rows ?? [];
    if (!rows.length) return [];
    const mailBy = new Map<number, MailDigestRow>();
    for (const m of digest?.rows ?? []) mailBy.set(m.rfq_id, m);
    const floor = isoDaysAgo(DAYS);

    const out: Card[] = [];
    for (const row of rows) {
      if (row.cancelled) continue;
      const mail = mailBy.get(row.rfq_id) ?? null;
      const acts = buildActivities(row, steps);
      const recentAct = acts.filter((a) => actIso(a) >= floor);
      // 카드가 될 자격은 "요즘 움직였나"로 정한다 — 최근 메일이 있거나 최근 사건이
      // 있거나. 다만 자격이 생긴 뒤에는 그 딜의 **마지막 대화를 기간과 무관하게**
      // 싣는다. 메일이 3주 전이 마지막이어도 44통이 쌓인 딜이라면, 그 사연이야말로
      // 카드에서 읽고 싶은 것이다.
      if (!(mail && mail.recent_count > 0) && !recentAct.length) continue;

      const lines: Line[] = [
        ...recentAct.map((act) => ({ at: actIso(act), kind: "act" as const, act })),
        ...(mail?.recent ?? []).map((m) => ({
          at: m.sent_at,
          kind: "mail" as const,
          dir: m.direction,
          party: m.party,
          text: m.summary,
        })),
      ];
      lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      out.push({
        row,
        mail,
        mailCount: mail?.count ?? digest?.has_mail?.[String(row.rfq_id)] ?? 0,
        lines,
        lastAt: lines[0]?.at || lastActivityISO(row),
        waitingDays: mail?.waiting_days ?? 0,
      });
    }

    // 정렬은 두 덩이다. 파이썬 쪽 집계와 같은 규칙 — 우리가 오래 쥐고 있는 건이 먼저,
    // 그다음이 최근에 움직인 순. 안정 정렬이라 뒤 정렬이 앞 정렬을 보존한다.
    out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    out.sort((a, b) => {
      const ga = a.waitingDays >= waitingAfter ? 0 : 1;
      const gb = b.waitingDays >= waitingAfter ? 0 : 1;
      return ga !== gb ? ga - gb : b.waitingDays - a.waitingDays;
    });
    return out;
  }, [pipeline, digest, steps, waitingAfter]);

  // 세 묶음은 서로 겹치지 않고 합이 전체다 — 칩의 수를 더하면 All 이 되어야 한다.
  const groupOf = (c: Card): Filter =>
    !c.mail || c.mail.recent_count === 0 ? "nomail"
      : c.waitingDays >= waitingAfter ? "ours" : "theirs";

  // 다시 써야 할 **카드**의 딜 번호 — 이걸 그대로 서버에 짚어 준다. 비어 있는 것뿐
  // 아니라 라벨 없는 옛 형식도 대상이다(아래 isLabelled 주석).
  const needDigest = cards
    .filter((c) => c.mail && !isLabelledRollup(c.mail.rollup))
    .map((c) => c.row.rfq_id);

  const counts = useMemo(() => {
    const n = { all: cards.length, ours: 0, theirs: 0, nomail: 0 };
    for (const c of cards) n[groupOf(c) as "ours" | "theirs" | "nomail"] += 1;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, waitingAfter]);

  const shown = useMemo(
    () => cards.filter((c) => filter === "all" || groupOf(c) === filter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cards, filter, waitingAfter]
  );

  const missing = needDigest.length;

  // 롤업 생성은 딜당 AI 호출 1회다. 한 번에 다 만들지 않고 상한까지만 만든 뒤
  // 남은 수를 알려 준다 — 눌러 놓고 20초를 기다리게 하는 것보다 낫다.
  async function writeDigests() {
    setBusy(true);
    setErr("");
    setNote("");
    try {
      const r = await refreshMailDigests(needDigest, 10);
      await refresh();
      setNote(
        r.remaining > 0
          ? `Wrote ${r.written} digests · ${r.remaining} left — press again to continue.`
          : `Wrote ${r.written} digests.`
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not write digests");
    } finally {
      setBusy(false);
    }
  }

  const openRow = openRfqId != null
    ? (pipeline?.rows ?? []).find((r) => r.rfq_id === openRfqId) ?? null
    : null;
  // 활동기록 팝업은 카드 밖(화면 끝)에서 연다 — 카드 안에서 열면 좁은 칸에 폼이 눌리고,
  // 카드가 제 높이 안에서 스크롤되므로 폼이 잘려 보인다.
  const addRow = addRfqId != null
    ? (pipeline?.rows ?? []).find((r) => r.rfq_id === addRfqId) ?? null
    : null;

  // 팝업의 ← → — 지금 보고 있는 **카드 순서**로 옮겨간다(필터와 정렬이 반영된 그 순서).
  // 프로젝트 번호순으로 넘기면 화면에 없는 딜로 튀어, 방금 훑던 자리를 잃는다.
  // 양 끝에서는 순환한다 — 다른 화면의 ← → 와 같은 규칙.
  function navigate(dir: -1 | 1) {
    setStageTarget(null);
    setOpenRfqId((cur) => {
      if (cur == null || !shown.length) return cur;
      const idx = shown.findIndex((c) => c.row.rfq_id === cur);
      if (idx < 0) return cur;
      const n = shown.length;
      return shown[(((idx + dir) % n) + n) % n].row.rfq_id;
    });
  }

  // ── 카드를 좌우로 넘긴다 ───────────────────────────────────────────────────
  // 카드를 세로로 쌓으면 열다섯 장을 보는 동안 상단 필터 줄이 멀어지고, 지금 몇 번째를
  // 보고 있는지도 잃는다. 그래서 한 줄(레일)에 옆으로 세우고 드래그와 양옆 화살표로 옮긴다.
  // Cols 는 이제 "한 번에 몇 장을 볼까"라는 뜻이 된다 — 밀도라는 성격은 그대로다.
  const barRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const dragged = useRef(false);   // 방금 끈 뒤라면 뒤따라오는 click 을 삼킨다
  const goal = useRef<number | null>(null);   // 부드럽게 가는 중인 목적지
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  // 카드 자리는 창의 남은 높이를 그대로 차지하고, 세로 스크롤은 그 안에서만 일어난다.
  // 높이를 상수로 빼지 않고 재는 이유는 위에 얹힌 것들(상단 바·탭 줄·필터 줄)이 창 폭에
  // 따라 접히고 늘기 때문이다 — 한 줄이 두 줄이 되는 순간 상수는 어긋난다.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top;
      // 아주 낮은 창에서는 억지로 줄이지 않는다 — 그럴 땐 페이지가 스크롤되고,
      // 필터 줄은 sticky 로 버틴다(아래 CSS).
      el.style.height = `${Math.max(320, window.innerHeight - top - 12)}px`;
    };
    fit();
    // 한 번 더. 방금까지 내용이 길어 페이지가 내려가 있었다면 첫 측정은 그 내려간
    // 자리에서 잰 값이다 — 높이를 넣어 페이지가 제자리로 돌아온 다음 프레임에 다시 잰다.
    const again = requestAnimationFrame(fit);
    window.addEventListener("resize", fit);
    // 칩이 두 줄로 접히면 필터 줄이 두꺼워진다 — 그때도 카드 자리를 다시 맞춘다.
    const ro = new ResizeObserver(fit);
    if (barRef.current) ro.observe(barRef.current);
    return () => {
      cancelAnimationFrame(again);
      window.removeEventListener("resize", fit);
      ro.disconnect();
    };
  }, [pipeline, err, note]);

  const updateEnds = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    if (goal.current != null && Math.abs(el.scrollLeft - goal.current) < 1) goal.current = null;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 1);
  }, []);

  // 카드 수·열 수·펼침이 바뀌면 트랙 길이가 바뀐다 — 양 끝 판정을 다시 한다.
  useEffect(() => { updateEnds(); }, [updateEnds, shown, cols, show, expanded]);
  useEffect(() => {
    window.addEventListener("resize", updateEnds);
    return () => window.removeEventListener("resize", updateEnds);
  }, [updateEnds]);
  // 묶음을 바꾸면 처음부터 본다 — 다른 목록의 열두 번째 자리에 남아 있을 이유가 없다.
  useEffect(() => {
    goal.current = null;
    railRef.current?.scrollTo({ left: 0 });
  }, [filter]);

  /** 카드 한 장의 이동 폭(카드 폭 + 간격). 두 장의 offsetLeft 차이가 가장 정확하다. */
  function cardStep(el: HTMLDivElement): number {
    const kids = el.children;
    if (kids.length >= 2) {
      const d = (kids[1] as HTMLElement).offsetLeft - (kids[0] as HTMLElement).offsetLeft;
      if (d > 0) return d;
    }
    return el.clientWidth || 1;
  }

  /** 화살표 한 번에 카드 한 장 — 한 화면씩 건너뛰면 방금 읽던 카드가 사라진다.
   *  연타는 목적지에서부터 센다. 지금 위치에서 세면 부드럽게 가는 도중의 어중간한
   *  자리가 기준이 되어, 두 번 눌러도 한 장밖에 안 넘어간다. */
  function go(dir: -1 | 1) {
    const el = railRef.current;
    if (!el) return;
    const s = cardStep(el);
    const from = goal.current ?? el.scrollLeft;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const left = Math.min(max, Math.max(0, (Math.round(from / s) + dir) * s));
    goal.current = left;
    el.scrollTo({ left, behavior: "smooth" });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragged.current = false;
    goal.current = null;
    const el = railRef.current;
    if (e.button !== 0 || !el) return;
    drag.current = { x: e.clientX, left: el.scrollLeft, moved: false };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const el = railRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < 6) return;   // 6px 넘게 끌어야 넘기기 — 그 아래는 클릭이다
      d.moved = true;
      dragged.current = true;
      // 끄는 동안은 스냅을 끈다. 켜 둔 채 scrollLeft 를 밀면 브라우저가 매번 가장
      // 가까운 카드로 되돌려, 손을 따라오지 않고 덜컥거린다.
      el.classList.add("dragging");
      try { el.setPointerCapture(e.pointerId); } catch { /* 캡처 못 해도 끌기는 된다 */ }
    }
    el.scrollLeft = d.left - dx;
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const el = railRef.current;
    drag.current = null;
    if (!d || !el) return;
    el.classList.remove("dragging");
    try { el.releasePointerCapture(e.pointerId); } catch { /* 이미 풀렸다 */ }
    // 손을 뗀 자리에서 가장 가까운 카드에 맞춘다(스냅을 껐던 만큼 우리가 맞춘다).
    if (d.moved) {
      const s = cardStep(el);
      el.scrollTo({ left: Math.round(el.scrollLeft / s) * s, behavior: "smooth" });
    }
  }

  const loadErr = digestErr ?? pipeErr;
  if (loadErr) return <div className="action-err">{loadErr.message}</div>;
  if (!pipeline) return <div className="state">Loading…</div>;

  return (
    <div className="brief">
      <div className="brief-bar" ref={barRef}>
        <span className="brief-chips">
          <Chip on={filter === "all"} onClick={() => setFilter("all")}>All <b>{counts.all}</b></Chip>
          <Chip on={filter === "ours"} onClick={() => setFilter("ours")}>
            Our move <b>{counts.ours}</b>
          </Chip>
          <Chip on={filter === "theirs"} onClick={() => setFilter("theirs")}>
            Waiting on them <b>{counts.theirs}</b>
          </Chip>
          {/* 최근 메일이 없는 딜 — 단계는 움직였는데 메일이 조용한 건들이다. 정말
              조용할 수도, 메일이 딜에 못 붙고 미분류에 쌓여 있을 수도 있다. */}
          <Chip on={filter === "nomail"} onClick={() => setFilter("nomail")}>
            No recent mail <b>{counts.nomail}</b>
          </Chip>
        </span>
        <span className="brief-acts">
          <span className="brief-show" role="group" aria-label="Lines per project">
            <span className="brief-show-lbl">Show</span>
            {SHOW_CHOICES.map((n) => (
              <button
                key={n}
                type="button"
                className={`brief-show-btn${show === n ? " on" : ""}`}
                // 밀도를 새로 정하면 개별로 펴 둔 카드는 접는다 — 이 버튼은 "전부
                // 이만큼"이라는 뜻이어야 하고, 그러지 않으면 눌러도 안 변하는 카드가
                // 남아 컨트롤을 믿을 수 없게 된다.
                onClick={() => { setShow(n); setExpanded([]); }}
              >
                {n}
              </button>
            ))}
          </span>
          {/* 열 수 — Show 와 같은 꼴의 옆 스위치. 둘 다 "이 보드를 어떻게 볼까"라는
              한 가지 질문의 두 축(세로 밀도 · 가로 폭)이라 나란히 둔다. */}
          <span className="brief-show" role="group" aria-label="Columns">
            <span className="brief-show-lbl">Cols</span>
            {COL_CHOICES.map((n) => (
              <button
                key={n}
                type="button"
                className={`brief-show-btn${cols === n ? " on" : ""}`}
                title={n === 2 ? "Two wide cards — easier to read one" : "Three cards — more deals on screen"}
                onClick={() => pickCols(n)}
              >
                {n}
              </button>
            ))}
          </span>
          {digest && digest.unmatched > 0 ? (
            <Link className="brief-warn" href="/activity?view=mail">
              {digest.unmatched} unmatched
            </Link>
          ) : null}
          {/* 등록 안 된 상대의 메일은 저장조차 되지 않는다 — 카드가 조용한 이유가
              "일이 없어서"가 아닐 수 있다는 걸 여기서 말해 준다. */}
          {status && status.unknown > 0 ? (
            <Link className="brief-warn" href="/settings?tab=mail">
              {status.unknown} unregistered
            </Link>
          ) : null}
          {missing > 0 ? (
            <button className="btn sm" disabled={busy} onClick={writeDigests}>
              {busy ? "Writing…" : `Write digests (${missing})`}
            </button>
          ) : null}
        </span>
      </div>

      {err ? <div className="action-err">{err}</div> : null}
      {note ? <div className="mail-note">{note}</div> : null}

      {/* 카드가 놓이는 틀. 창의 남은 높이를 그대로 차지하고 스스로는 스크롤하지 않는다 —
          위의 필터·Show·Cols 줄이 이 틀 **밖**에 있으니 움직일 방법이 없다. sticky 로만
          붙여 두면 스크롤 컨테이너가 페이지라, 화면 사정이 조금만 달라져도 풀린다.
          긴 딜은 카드 안에서 스크롤된다(globals.css 의 .brief-rail > .brief-card). */}
      <div className="brief-body" ref={bodyRef}>
      {shown.length === 0 ? (
        <p className="mail-empty">
          {cards.length === 0
            ? `Nothing moved in the last ${DAYS} days.`
            : "Nothing in this filter."}
        </p>
      ) : (
        <div className="brief-deck">
          <DeckNav dir={-1} disabled={atStart} onClick={() => go(-1)} />
          <div
            ref={railRef}
            className={`brief-rail cols-${cols}`}
            role="group"
            aria-label="Project cards"
            tabIndex={0}
            onScroll={updateEnds}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            // 끌고 나서 손을 뗀 자리가 마침 버튼 위였다고 그 버튼이 눌리면 안 된다.
            onClickCapture={(e) => {
              if (!dragged.current) return;
              dragged.current = false;
              e.preventDefault();
              e.stopPropagation();
            }}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              go(e.key === "ArrowLeft" ? -1 : 1);
            }}
          >
            {shown.map((c) => (
              <BriefCard
                key={c.row.rfq_id}
                card={c}
                steps={steps}
                show={show}
                open={expanded.includes(c.row.rfq_id)}
                onToggle={() =>
                  setExpanded((prev) =>
                    prev.includes(c.row.rfq_id)
                      ? prev.filter((id) => id !== c.row.rfq_id)
                      : [...prev, c.row.rfq_id]
                  )
                }
                waitingAfter={waitingAfter}
                onOpen={() => { setStageTarget(null); setOpenRfqId(c.row.rfq_id); }}
                onOpenStage={(act) => {
                  if (act.kind !== "auto") return;
                  setStageTarget({ stage: act.stage, vrfqId: act.vrfqId });
                  setOpenRfqId(c.row.rfq_id);
                }}
                onAdd={() => setAddRfqId(c.row.rfq_id)}
              />
            ))}
          </div>
          <DeckNav dir={1} disabled={atEnd} onClick={() => go(1)} />
        </div>
      )}
      </div>

      {openRow ? (
        <PipelineModal
          r={openRow}
          steps={steps}
          customers={customers ?? []}
          vessels={vessels ?? []}
          onChanged={() => Promise.all([refreshPipeline(), refresh()])}
          onClose={() => { setOpenRfqId(null); setStageTarget(null); }}
          onNavigate={navigate}
          initialView={stageTarget ? "work" : "overview"}
          initialStage={stageTarget?.stage ?? null}
          initialVrfqId={stageTarget?.vrfqId ?? null}
        />
      ) : null}

      {addRow ? (
        <Modal
          title={`Add activity · ${addRow.project_no}${addRow.project_title ? ` ${addRow.project_title}` : ""}`}
          onClose={() => setAddRfqId(null)}
          form
        >
          <BriefAddNote
            row={addRow}
            steps={steps}
            // 새 기록은 파이프라인에서 온다(stage_notes) — 메일 집계는 건드리지 않으니
            // 그쪽까지 다시 부르지 않는다.
            onDone={async () => { setAddRfqId(null); await refreshPipeline(); }}
            onCancel={() => setAddRfqId(null)}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`mail-chip${on ? " on" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

// 트랙 양옆의 세로로 긴 버튼. 카드 줄과 같은 높이라 어디를 눌러도 넘어가고, 세로로
// 긴 카드를 읽으며 내려가도 손 닿는 자리에 남는다(화살표 글자만 화면 안에 붙어 온다).
// 딜 하나가 겨우 몇 장일 때 화살표가 벽처럼 보이지 않게, 끝에서는 흐려 둔다.
function DeckNav({
  dir,
  disabled,
  onClick,
}: {
  dir: -1 | 1;
  disabled: boolean;
  onClick: () => void;
}) {
  const prev = dir < 0;
  return (
    <button
      type="button"
      className={`brief-nav${prev ? " prev" : " next"}`}
      disabled={disabled}
      onClick={onClick}
      title={prev ? "Previous card (←)" : "Next card (→)"}
      aria-label={prev ? "Previous card" : "Next card"}
    >
      <span aria-hidden>{prev ? "‹" : "›"}</span>
    </button>
  );
}

function BriefCard({
  card,
  steps,
  show,
  open,
  onToggle,
  waitingAfter,
  onOpen,
  onOpenStage,
  onAdd,
}: {
  card: Card;
  steps: string[];
  show: number;
  open: boolean;               // 이 카드만 통째로 편 상태
  onToggle: () => void;
  waitingAfter: number;
  onOpen: () => void;
  onOpenStage: (act: Activity) => void;
  onAdd: () => void;
}) {
  const { row, mail } = card;
  const waiting = card.waitingDays >= waitingAfter;
  const stageLabel = row.stage > 0 ? steps[row.stage - 1] || "" : "";
  const vessel = (row.vessels || row.vessel || "").split("\n").filter(Boolean).join(" · ");
  const vend = vendorOf(row);
  const age = daysSinceISO(card.lastAt);
  const lines = mail?.rollup
    ? mail.rollup.split("\n").map((l) => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean)
    : [];

  return (
    <section className={`brief-card${waiting ? " waiting" : ""}${row.work_type === "서비스" ? " service" : ""}`}>
      {/* 제목 줄에는 제목만 둔다. 단계 배지가 여기 있으면 카드마다 다른 길이로 제목을
          잘라 먹어, 정작 딜을 알아보게 하는 글자가 먼저 사라졌다. 배지는 아래
          진행바 옆으로 — 몇 번째 칸까지 찼는지를 바로 그 자리에서 읽게 된다. */}
      <button type="button" className="brief-head" onClick={onOpen}>
        <span className="brief-no"><ProjectNo value={row.project_no} /></span>
        <span className="brief-title">{row.project_title || "(untitled)"}</span>
        {row.assignee ? <span className="brief-pic">{row.assignee}</span> : null}
      </button>

      <div className="brief-parties">
        {row.customer ? (
          <span className="brief-cust">
            <CustomerName name={row.customer} />
            {row.contact_person ? <span className="brief-contact"> · {row.contact_person}</span> : null}
          </span>
        ) : null}
        {vend ? <VendorMonograms value={vend} statuses={row.vendor ? undefined : row.rfq_vendors} /> : null}
        {vessel ? <span className="brief-vessel" title={vessel}>{vessel}</span> : null}
      </div>

      {/* 무엇을, 얼마에 — 카드는 위에서 아래로 "누구와(상대) → 무엇을(품목) →
          얼마에(금액) → 어디까지(단계) → 누구 차례(상태) → 무슨 일이(줄)"로 읽힌다. */}
      {row.first_item ? (
        <p className="brief-item" title={row.first_item}>
          {row.first_item}
          {row.item_count > 1 ? (
            <span className="brief-item-more"> 외 {row.item_count - 1}개 품목</span>
          ) : null}
        </p>
      ) : null}
      <MoneyRow row={row} />

      {steps.length || stageLabel ? (
        <div className="brief-track" title={stageLabel ? `Current stage: ${stageLabel}` : undefined}>
          <div className="brief-steps">
            {steps.map((_, i) => (
              <span key={i} className={`brief-step${i < row.stage ? " on" : ""}`} />
            ))}
          </div>
          {stageLabel ? (
            <span className="brief-stage">
              <b>{row.stage}</b> {stageLabel}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="brief-state">
        {/* 메일이 아예 없는 것과, 있는데 요즘 조용한 것은 다른 상태다 — 뒤엣것은
            아래에 그 딜의 마지막 대화가 그대로 실려 있다. 통수는 mailCount 로 본다
            (집계 상한에 걸려 이번 응답에 안 실린 딜도 "없음"이 아니다). */}
        <span className={`mail-turn${waiting ? " ours" : ""}`}>
          {!card.mailCount
            ? "No mail linked"
            : !mail || mail.recent_count === 0
              ? `Quiet since ${md(mail?.last_at || card.lastAt)}`
              : waiting
                ? `Our move · ${card.waitingDays}d`
                : mail.last_dir === "in"
                  ? "Just received"
                  : "Waiting on them"}
        </span>
        <span className="brief-when">
          {md(card.lastAt)}
          {hm(card.lastAt) ? ` ${hm(card.lastAt)}` : ""}
          {age != null ? <b className={`brief-age lv-${level(row, age)}`}>{age}d</b> : null}
        </span>
      </div>

      {lines.length ? (
        <ul className={`mail-card-rollup${mail?.rollup_stale ? " stale" : ""}`}>
          {lines.map((l, i) => (
            <RollupLine key={i} text={l} />
          ))}
          {mail?.rollup_stale ? (
            <li className="mail-card-since">
              {mail.new_since > 0
                ? `+ ${mail.new_since} newer mail${mail.new_since === 1 ? "" : "s"} below`
                : "newer mail has arrived since this"}
            </li>
          ) : null}
        </ul>
      ) : null}

      {/* 활동기록을 더하는 자리는 기록이 쌓이는 자리 바로 위다 — 방금 읽은 줄 아래에
          한 줄 더 얹는 일이라, 푸터(카드 관리 줄)보다 여기가 맞다. */}
      <div className="brief-log-head">
        <span className="brief-log-title">Activity</span>
        <button
          type="button"
          className="brief-add"
          onClick={onAdd}
          title="Add an activity note to this deal"
          aria-label="Add activity note"
        >
          +
        </button>
      </div>

      {/* 사건과 메일을 한 시간축에. 사건은 굵은 라벨(Quote Sent…), 메일은 방향 화살표로
          갈라 보이되 줄 간격은 같다 — 둘은 같은 이야기의 두 면이다. */}
      <ol className="brief-lines">
        {card.lines.slice(0, open ? card.lines.length : show).map((l, i) => (
          <li key={i} className={l.kind === "mail" ? `brief-line mail ${l.dir}` : "brief-line act"}>
            <span className="brief-line-when">
              {md(l.at)}
              {hm(l.at) ? <span className="act-time"> {hm(l.at)}</span> : null}
            </span>
            {l.kind === "act" ? (
              <span className="brief-line-desc">
                <ActivityDesc
                  act={l.act}
                  onOpen={l.act.kind === "auto" ? () => onOpenStage(l.act) : undefined}
                />
              </span>
            ) : (
              <>
                <span className="mail-dir">{l.dir === "out" ? "→" : "←"}</span>
                <span className="brief-line-party">{l.party || "—"}</span>
                <span className="brief-line-desc">{l.text}</span>
              </>
            )}
          </li>
        ))}
      </ol>

      <div className="brief-foot">
        <span>
          {card.mailCount
            ? `${card.mailCount} mail${card.mailCount === 1 ? "" : "s"}`
            : "no mail linked"}
          {card.mailCount && (!mail || mail.recent_count === 0) ? ` · none in ${DAYS}d` : ""}
        </span>
        {/* 이 카드만 펴고 접는 자리 — 새 버튼을 달지 않고 원래 있던 "N more" 를 누를 수
            있게 했다. 카드마다 같은 장식이 하나씩 늘면 보드가 그만큼 시끄러워진다. */}
        {card.lines.length > show ? (
          <button type="button" className="brief-more" onClick={onToggle}>
            {open ? "show less ▴" : `${card.lines.length - show} more ▾`}
          </button>
        ) : null}
        <button type="button" className="mail-card-open" onClick={onOpen}>Open ▸</button>
      </div>
    </section>
  );
}

// 활동기록 입력 팝업의 속. 폼은 Activity·개요 화면과 같은 것을 쓰고(ActivityNoteForm),
// 저장도 같은 stage_notes 로 간다 — 여기서 남긴 줄이 다른 화면에서 안 보이면, 화면마다
// 다른 업무일지를 쓰는 셈이 된다.
//
// 붙는 단계는 고르게 하지 않고 입력한 일시로 정한다(stageForNote). 카드에는 단계를 고를
// 자리가 없고, 지금 남기는 기록은 대개 지금 단계의 일이다.
function BriefAddNote({
  row,
  steps,
  onDone,
  onCancel,
}: {
  row: PipelineRow;
  steps: string[];
  onDone: () => void | Promise<unknown>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ActivityNoteValue>(() => initialNoteValue());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    if (!form.text.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const patch = noteFormToPatch(form);
      const chain = buildStageChain(row, resolveSteps(steps, row.work_type));
      const stage = stageForNote(chain, patch.datetime || "", row.stage);
      await addRfqStageNote(row.rfq_id, stage, patch);
      await onDone();
    } catch (e) {
      // 실패를 카드 안에서 말한다 — 폼은 그대로 두어 쓴 내용을 잃지 않게.
      setErr(e instanceof Error ? e.message : "Could not save the note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="brief-add-note">
      <ActivityNoteForm
        value={form}
        onChange={setForm}
        onSubmit={submit}
        onCancel={onCancel}
        submitLabel="Add"
        busy={busy}
        partyPresets={activityParties(row)}
        personPresets={activityPersons(row)}
        dialog
      />
      {err ? <div className="action-err">{err}</div> : null}
    </div>
  );
}

// 판매·매입·마진 한 줄. 값은 서버가 이미 이중통화 문자열("USD 12,500 KRW 17,000,000")로
// 만들어 준다 — 카드 폭에 그 여섯 덩이를 다 늘어놓을 수 없으니 앞 통화만 세우고 나머지는
// 마우스를 올렸을 때 보여 준다(같은 세 숫자를 Projects 화면도 Sales/Purchase/Margin 으로
// 부른다 — 이름이 화면마다 달라지면 같은 값인지 알아보기 어렵다).
function MoneyRow({ row }: { row: PipelineRow }) {
  const has = row.sales_total || row.purchase_total || row.margin_amount;
  if (!has) return null;
  const loss = row.margin_pct != null && row.margin_pct < 0;
  // 매입 → 매출 → 마진 순. 마진은 앞 두 값의 결과라 마지막에 놓여야 눈이 좌에서
  // 우로 읽으며 계산을 따라간다.
  return (
    <p className="brief-money">
      <Money label="Purchase" value={row.purchase_total} />
      <Money label="Sales" value={row.sales_total} />
      <Money label="Margin" value={row.margin_amount} tone={loss ? "loss" : ""}>
        {row.margin_pct != null ? (
          <span className="brief-money-pct">{row.margin_pct}%</span>
        ) : null}
      </Money>
    </p>
  );
}

function Money({
  label,
  value,
  tone = "",
  children,
}: {
  label: string;
  value?: string | null;
  tone?: string;
  children?: React.ReactNode;
}) {
  if (!value) return null;
  return (
    <span className={`brief-money-cell${tone ? ` ${tone}` : ""}`} title={value}>
      <span className="brief-money-lbl">{label}</span>
      {primaryAmount(value)}
      {children}
    </span>
  );
}

/** "USD 12,500 KRW 17,000,000" → "USD 12,500". 둘째 통화는 툴팁에만 남긴다. */
function primaryAmount(value: string): string {
  return value.trim().split(/\s+(?=[A-Z]{3}\s)/)[0] || value;
}

// 요약 한 줄 — "진행: …" 처럼 라벨이 붙어 오면 라벨만 떼어 왼쪽 칸에 세운다(파싱과
// 영문 라벨은 lib/rollup 이 맡는다 — 딜 화면의 Mail 정리도 같은 규칙을 쓴다).
// 예전에 만들어 둔 "- 문장" 꼴 요약도 그대로 한 줄로 나온다.
//
// 네 줄은 무게가 다르다. Progress 는 이미 지나간 배경이고, Next 는 오늘 손을 대야 하는
// 유일한 줄이다. 같은 크기·같은 검정으로 찍으면 넷이 한 덩어리로 뭉쳐 아무것도 먼저
// 읽히지 않는다 — 그래서 라벨은 흐리게 옆으로 빼고, 본문만 종류별로 힘을 달리한다.
function RollupLine({ text }: { text: string }) {
  const parsed = parseRollupLine(text);
  if (!parsed) return <li className="plain">{text}</li>;
  const { kind, label, body } = parsed;
  return (
    <li className={kind}>
      <b className="mail-card-label">{label}</b>
      <span className="mail-card-val">
        {kind === "flow" ? <FlowText text={body} />
          : kind === "terms" ? <TermsText text={body} />
            : body}
      </span>
    </li>
  );
}

/** 진행 줄 — "7/30 상대 → 한 일 → 8/3 …" 꼴의 긴 사슬. 통째로 두면 벽처럼 읽히니
 *  날짜는 굵게 세우고 이음표는 흐리게 눕혀, 눈이 마디마다 쉴 자리를 만든다. */
function FlowText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(→|\d{1,2}\/\d{1,2})/g).map((p, i) =>
        p === "→" ? <span key={i} className="rollup-arrow">→</span>
          : /^\d{1,2}\/\d{1,2}$/.test(p) ? <b key={i} className="rollup-date">{p}</b>
            : <span key={i}>{p}</span>
      )}
    </>
  );
}

/** 금액·납기 줄 — 이 줄에서 눈이 찾는 건 숫자 하나다. 자릿점 있는 금액만 세운다
 *  (납기 "14일"까지 굵히면 줄 전체가 굵어져 아무것도 안 세운 것과 같아진다). */
function TermsText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\d{1,3}(?:,\d{3})+)/g).map((p, i) =>
        /^\d{1,3}(?:,\d{3})+$/.test(p)
          ? <b key={i} className="rollup-num">{p}</b>
          : <span key={i}>{p}</span>
      )}
    </>
  );
}

/** 활동 1건의 정렬용 일시 — 시각이 있으면 그것, 없으면 날짜. */
function actIso(act: Activity): string {
  if (act.kind === "note") return act.note.datetime || act.note.at || act.date;
  if (act.kind === "auto") return act.at || act.date;
  return act.date;
}

/** n일 전 날짜(ISO) — 카드에 올릴 사건의 하한. */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** 경과일 강조 — Activity 화면과 같은 기준(7일 주의 / 14일 경고). */
function level(row: PipelineRow, age: number): "normal" | "warn" | "urgent" {
  return row.next_level ?? (age >= 14 ? "urgent" : age >= 7 ? "warn" : "normal");
}
