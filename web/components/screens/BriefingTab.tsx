"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
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
import ActivityDesc from "@/components/common/ActivityDesc";
import CustomerName from "@/components/common/CustomerName";
import ProjectNo from "@/components/common/ProjectNo";
import VendorMonograms from "@/components/common/VendorMonograms";
import { buildActivities, daysSinceISO, hm, lastActivityISO, md } from "@/lib/activity";
import type { Activity } from "@/lib/activity";
import { vendorOf } from "@/lib/deal";

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
  const [show, setShow] = useState(3);          // 카드마다 보여 줄 최근 줄 수
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [openRfqId, setOpenRfqId] = useState<number | null>(null);
  const [stageTarget, setStageTarget] = useState<{ stage: number; vrfqId?: number } | null>(null);

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

  // 요약이 비어 있는 **카드**의 딜 번호 — 이걸 그대로 서버에 짚어 준다.
  const needDigest = cards.filter((c) => c.mail && !c.mail.rollup).map((c) => c.row.rfq_id);

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

  const loadErr = digestErr ?? pipeErr;
  if (loadErr) return <div className="action-err">{loadErr.message}</div>;
  if (!pipeline) return <div className="state">Loading…</div>;

  return (
    <div className="brief">
      <div className="brief-bar">
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
                onClick={() => setShow(n)}
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

      {shown.length === 0 ? (
        <p className="mail-empty">
          {cards.length === 0
            ? `Nothing moved in the last ${DAYS} days.`
            : "Nothing in this filter."}
        </p>
      ) : (
        <div className="brief-grid">
          {shown.map((c) => (
            <BriefCard
              key={c.row.rfq_id}
              card={c}
              steps={steps}
              show={show}
              waitingAfter={waitingAfter}
              onOpen={() => { setStageTarget(null); setOpenRfqId(c.row.rfq_id); }}
              onOpenStage={(act) => {
                if (act.kind !== "auto") return;
                setStageTarget({ stage: act.stage, vrfqId: act.vrfqId });
                setOpenRfqId(c.row.rfq_id);
              }}
            />
          ))}
        </div>
      )}

      {openRow ? (
        <PipelineModal
          r={openRow}
          steps={steps}
          customers={customers ?? []}
          vessels={vessels ?? []}
          onChanged={() => Promise.all([refreshPipeline(), refresh()])}
          onClose={() => { setOpenRfqId(null); setStageTarget(null); }}
          initialView={stageTarget ? "work" : "overview"}
          initialStage={stageTarget?.stage ?? null}
          initialVrfqId={stageTarget?.vrfqId ?? null}
        />
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

function BriefCard({
  card,
  steps,
  show,
  waitingAfter,
  onOpen,
  onOpenStage,
}: {
  card: Card;
  steps: string[];
  show: number;
  waitingAfter: number;
  onOpen: () => void;
  onOpenStage: (act: Activity) => void;
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
      <button type="button" className="brief-head" onClick={onOpen}>
        <span className="brief-no"><ProjectNo value={row.project_no} /></span>
        <span className="brief-title">{row.project_title || "(untitled)"}</span>
        {stageLabel ? (
          <span className="brief-stage" title={`Current stage: ${stageLabel}`}>
            {row.stage} {stageLabel}
          </span>
        ) : null}
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

      {steps.length ? (
        <div className="brief-steps" title={stageLabel ? `Current stage: ${stageLabel}` : undefined}>
          {steps.map((_, i) => (
            <span key={i} className={`brief-step${i < row.stage ? " on" : ""}`} />
          ))}
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

      {/* 사건과 메일을 한 시간축에. 사건은 굵은 라벨(Quote Sent…), 메일은 방향 화살표로
          갈라 보이되 줄 간격은 같다 — 둘은 같은 이야기의 두 면이다. */}
      <ol className="brief-lines">
        {card.lines.slice(0, show).map((l, i) => (
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
          {card.lines.length > show ? ` · ${card.lines.length - show} more` : ""}
        </span>
        <button type="button" className="mail-card-open" onClick={onOpen}>Open ▸</button>
      </div>
    </section>
  );
}

// 요약 한 줄 — "진행: …" 처럼 라벨이 붙어 오면 라벨만 떼어 굵게 세운다.
// 넷 중 하나일 때만 라벨로 본다(본문에 콜론이 있다고 라벨이 되면 안 된다).
// 예전에 만들어 둔 "- 문장" 꼴 요약도 그대로 한 줄로 나온다.
const ROLLUP_LABELS = ["진행", "쟁점", "금액·납기", "다음"];

function RollupLine({ text }: { text: string }) {
  const at = text.search(/[:：]/);
  const label = at > 0 ? text.slice(0, at).trim() : "";
  if (!ROLLUP_LABELS.includes(label)) return <li>{text}</li>;
  return (
    <li className={label === "다음" ? "next" : undefined}>
      <b className="mail-card-label">{label}</b>
      {text.slice(at + 1).trim()}
    </li>
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
