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
import PartyName from "@/components/common/PartyName";
import ProjectNo from "@/components/common/ProjectNo";
import { md, hm } from "@/lib/activity";

// 대시보드 Mail 탭 — 프로젝트 하나가 카드 하나.
//
// 아침에 훑는 화면이다. 표가 아니라 카드인 이유는, 여기서 알고 싶은 게 "몇 건인가"가
// 아니라 "이 건이 지금 어디까지 왔고 다음 차례가 누구인가"이기 때문이다. 그래서 카드
// 한 장에 딜의 신원(번호·제목·고객·단계) / 지금 상태(공이 누구에게) / 흐름(AI 요약)
// / 최근 몇 줄이 위에서 아래로 놓인다.
//
// 데이터는 두 곳에서 온다. 메일 쪽은 /mail/digest 집계 하나, 프로젝트 이름·단계·
// 담당자는 화면이 이미 갖고 있는 pipeline 목록이다(같은 계산을 서버에 두 번 시키지
// 않는다). 캐시 키를 Home 탭과 공유하므로 탭을 오가도 다시 부르지 않는다.

type Filter = "all" | "ours" | "theirs";

const DAYS = 14;

export default function MailDigestTab() {
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
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [openRfqId, setOpenRfqId] = useState<number | null>(null);

  const byRfqId = useMemo(() => {
    const m = new Map<number, PipelineRow>();
    for (const r of pipeline?.rows ?? []) m.set(r.rfq_id, r);
    return m;
  }, [pipeline]);

  const rows = digest?.rows ?? [];
  const waitingAfter = digest?.waiting_after ?? 2;
  const shown = useMemo(
    () =>
      rows.filter((r) =>
        filter === "ours"
          ? r.waiting_days >= waitingAfter
          : filter === "theirs"
            ? r.waiting_days < waitingAfter
            : true
      ),
    [rows, filter, waitingAfter]
  );
  // 요약이 아직 없는 카드 수 — 일괄 생성 버튼의 숫자.
  const missing = rows.filter((r) => !r.rollup).length;

  // 롤업 생성은 딜당 AI 호출 1회다. 한 번에 다 만들지 않고 상한까지만 만든 뒤
  // 남은 수를 알려 준다 — 눌러 놓고 20초를 기다리게 하는 것보다 낫다.
  async function writeDigests() {
    setBusy(true);
    setErr("");
    setNote("");
    try {
      const r = await refreshMailDigests(DAYS, 10);
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

  const openProject = openRfqId != null ? byRfqId.get(openRfqId) ?? null : null;

  // 조회가 실패했는데 "Loading…" 만 계속 두면 화면이 조용히 멈춘 것처럼 보인다.
  const loadErr = digestErr ?? pipeErr;
  if (loadErr) return <div className="action-err">{loadErr.message}</div>;
  if (!digest || !pipeline) return <div className="state">Loading…</div>;

  return (
    <div className="mail-digest">
      <div className="mail-digest-bar">
        <span className="mail-digest-chips">
          <Chip on={filter === "all"} onClick={() => setFilter("all")}>
            All <b>{rows.length}</b>
          </Chip>
          <Chip on={filter === "ours"} onClick={() => setFilter("ours")}>
            Our move <b>{rows.filter((r) => r.waiting_days >= waitingAfter).length}</b>
          </Chip>
          <Chip on={filter === "theirs"} onClick={() => setFilter("theirs")}>
            Waiting on them <b>{rows.filter((r) => r.waiting_days < waitingAfter).length}</b>
          </Chip>
        </span>
        <span className="mail-digest-acts">
          {digest.unmatched > 0 ? (
            <Link className="mail-digest-unmatched" href="/activity?view=mail">
              {digest.unmatched} unmatched
            </Link>
          ) : null}
          {/* 등록 안 된 상대의 메일은 저장조차 되지 않는다 — 카드에 없는 이유가
              "일이 없어서"가 아닐 수 있다는 걸 여기서 말해 준다. */}
          {status && status.unknown > 0 ? (
            <Link className="mail-digest-unmatched" href="/settings?tab=mail">
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
          {rows.length === 0
            ? `No mail exchanged in the last ${digest.days} days. Run Sync from a project's Mail panel to read the mailbox.`
            : "Nothing in this filter."}
        </p>
      ) : (
        <div className="mail-digest-grid">
          {shown.map((r) => (
            <DigestCard
              key={r.rfq_id}
              row={r}
              deal={byRfqId.get(r.rfq_id)}
              steps={pipeline.steps}
              waitingAfter={waitingAfter}
              onOpen={() => setOpenRfqId(r.rfq_id)}
            />
          ))}
        </div>
      )}

      {openProject ? (
        <PipelineModal
          r={openProject}
          steps={pipeline.steps}
          customers={customers ?? []}
          vessels={vessels ?? []}
          onChanged={() => Promise.all([refreshPipeline(), refresh()])}
          onClose={() => setOpenRfqId(null)}
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

function DigestCard({
  row,
  deal,
  steps,
  waitingAfter,
  onOpen,
}: {
  row: MailDigestRow;
  deal?: PipelineRow;
  steps: string[];
  waitingAfter: number;
  onOpen: () => void;
}) {
  const waiting = row.waiting_days >= waitingAfter;
  // 요약이 아직 없는 카드는 비워 두지 않고 최근 메일 줄로 대신한다 — 이미 DB 에
  // 있는 값이라 공짜고, "아직 안 만들었다"는 사실은 흐린 글씨로만 알린다.
  const lines = row.rollup
    ? row.rollup.split("\n").map((l) => l.replace(/^[-•]\s*/, "")).filter(Boolean)
    : [];

  return (
    <section className={`mail-card${waiting ? " waiting" : ""}`}>
      <button type="button" className="mail-card-head" onClick={onOpen}>
        <span className="mail-card-no">
          <ProjectNo value={deal?.project_no} />
        </span>
        <span className="mail-card-title">{deal?.project_title || "(untitled)"}</span>
        {deal ? (
          <span className="mail-card-stage" title={steps[deal.stage - 1] || ""}>
            {deal.stage} {steps[deal.stage - 1] || ""}
          </span>
        ) : null}
        {deal?.assignee ? <span className="mail-card-pic">{deal.assignee}</span> : null}
      </button>

      <div className="mail-card-parties">
        {row.parties.slice(0, 3).map((p) => (
          <PartyName key={p} name={p} />
        ))}
        {deal?.vessel ? <span className="mail-card-vessel">{deal.vessel}</span> : null}
      </div>

      <div className="mail-card-state">
        <span className={`mail-turn${waiting ? " ours" : ""}`}>
          {waiting
            ? `Our move · ${row.waiting_days}d`
            : row.last_dir === "in"
              ? "Just received"
              : "Waiting on them"}
        </span>
        <span className="mail-card-when">
          {row.last_dir === "out" ? "→" : "←"} {when(row.last_at)}
        </span>
      </div>

      {lines.length ? (
        <ul className="mail-card-rollup">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="mail-card-nodigest">No digest yet — showing the latest mail.</p>
      )}

      <ol className="mail-card-recent">
        {row.recent.map((m, i) => (
          <li key={i}>
            <span className="mail-dir">{m.direction === "out" ? "→" : "←"}</span>
            <span className="mail-when">{when(m.sent_at)}</span>
            <span className="mail-card-party">{m.party || "—"}</span>
            <span className="mail-card-sum">{m.summary}</span>
          </li>
        ))}
      </ol>

      <div className="mail-card-foot">
        <span>
          {row.count} mail{row.count === 1 ? "" : "s"} · {row.parties.length} part
          {row.parties.length === 1 ? "y" : "ies"}
          {row.rollup_stale ? <b className="mail-card-new"> · new mail since digest</b> : null}
        </span>
        <button type="button" className="mail-card-open" onClick={onOpen}>
          Open ▸
        </button>
      </div>
    </section>
  );
}

/** "2026-08-11T09:30" → "8/11 09:30"(시각이 없으면 날짜만). */
function when(iso: string): string {
  const t = hm(iso);
  return t ? `${md(iso)} ${t}` : md(iso);
}
