"use client";

import { useState } from "react";
import { CLOSE_REASONS, closeReasonCodes, joinCloseReasons, nowLocalDateTime, setRfqCancelled } from "@/lib/api";

/**
 * 딜 종결 사유 고르기 — 닫을 때(mode="close")와 이미 닫힌 건의 사유를 고칠 때
 * (mode="edit") 같은 화면을 쓴다. 두 벌로 두면 갈래를 하나 늘릴 때마다 두 군데를
 * 고쳐야 하고, 곧 한쪽만 고치게 된다.
 *
 * 저장은 같은 API(cancel) 한 곳 — 종결 상태가 바뀌지 않으면 서버가 활동기록에 줄을
 * 남기지 않으므로, 사유만 고쳐 다시 저장해도 로그가 더러워지지 않는다.
 */
export default function CloseReasonDialog({
  rfqId,
  mode = "close",
  initialCode = "",
  initialNote = "",
  initialAt = "",
  onSaved,
  onClose,
}: {
  rfqId: number;
  mode?: "close" | "edit";
  initialCode?: string | null;
  initialNote?: string | null;
  /** 이미 닫힌 건의 종결 일시(edit 모드). 비면 지금 시각으로 채운다. */
  initialAt?: string | null;
  /** 저장 후 목록·화면을 다시 읽는다. */
  onSaved: () => void | Promise<unknown>;
  onClose: () => void;
}) {
  // 사유는 여러 갈래를 함께 고른다 — 한 갈래로 줄이라고 강요하면 "메이커가 직접 견적을
  // 냈고 그쪽이 1/3 가격이었다" 같은 건에서 둘 중 하나가 통째로 사라진다.
  const [codes, setCodes] = useState<string[]>(() => closeReasonCodes(initialCode));
  const [note, setNote] = useState(initialNote || "");
  // 언제 닫았는지 — 시스템에 늦게 반영하는 일이 잦아 저장 시각과 따로 받는다.
  const [at, setAt] = useState(() => (initialAt || "").slice(0, 16) || nowLocalDateTime());
  const [busy, setBusy] = useState(false);
  const editing = mode === "edit";
  // 'Other' 는 노트가 곧 사유라 비워 둘 수 없다. 그 밖의 갈래는 노트가 덧붙임(선택).
  const ready = codes.length > 0 && (!codes.includes("other") || !!note.trim()) && !!at;

  function toggle(code: string) {
    setCodes((cur) => (cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]));
  }

  async function save() {
    if (busy || !ready) return;
    setBusy(true);
    try {
      await setRfqCancelled(rfqId, true, joinCloseReasons(codes), note.trim() || undefined, at);
      await onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="close-reason-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      role="presentation"
    >
      <div
        className="close-reason-modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Edit close reason" : "Close deal reason"}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="close-reason-title">
          {editing ? "Edit the close reason" : "Close this deal"}
        </div>
        <div className="close-reason-sub">
          {editing
            ? "The deal stays closed — only the reason and date change. The close entry in the activity log is updated, not duplicated."
            : "Select a reason. It will move to the Closed zone on the board — you can reactivate it anytime."}
          {" Pick as many as apply."}
        </div>
        <div className="close-reason-list">
          {CLOSE_REASONS.map((opt) => (
            <label
              key={opt.code}
              className={`close-reason-opt${codes.includes(opt.code) ? " sel" : ""}`}
            >
              <input
                type="checkbox"
                name="close-reason"
                value={opt.code}
                checked={codes.includes(opt.code)}
                onChange={() => toggle(opt.code)}
              />
              <span className={`close-badge tone-${opt.tone}`}>{opt.badge}</span>
              <span className="close-reason-txt">{opt.label}</span>
            </label>
          ))}
        </div>
        {/* 갈래로는 다 담기지 않는 사정(어느 메이커가·얼마나 비쌌는지)은 여기 남는다.
            갈래는 세기 위한 것이고, 이 글은 다음에 같은 고객을 만났을 때 읽을 것이다. */}
        {codes.length ? (
          <textarea
            className="close-reason-note"
            placeholder={codes.includes("other") ? "Enter the reason" : "Add a note (optional)"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
          />
        ) : null}
        <DateTimeField label="Closed on" value={at} onChange={setAt} />
        <div className="close-reason-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy || !ready}>
            {busy ? "Saving…" : editing ? "Save reason" : "Close deal"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 종결·재활성 일시 입력칸 — 두 다이얼로그가 같이 쓴다. */
function DateTimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="close-reason-when">
      <span>{label}</span>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      />
      <button type="button" className="btn sm" onClick={() => onChange(nowLocalDateTime())}>
        Now
      </button>
    </label>
  );
}

/**
 * 딜 재활성 — 언제 되살렸는지 일시를 받아 활동기록에 남긴다.
 * 종결 일시와 짝을 이뤄 "얼마 동안 닫혀 있었나"를 나중에 읽을 수 있게.
 */
export function ReactivateDialog({
  rfqId,
  closedAt,
  onSaved,
  onClose,
}: {
  rfqId: number;
  closedAt?: string | null;
  onSaved: () => void | Promise<unknown>;
  onClose: () => void;
}) {
  const [at, setAt] = useState(() => nowLocalDateTime());
  const [busy, setBusy] = useState(false);
  const closed = (closedAt || "").slice(0, 16);
  const beforeClose = !!closed && !!at && at < closed;

  async function save() {
    if (busy || !at || beforeClose) return;
    setBusy(true);
    try {
      await setRfqCancelled(rfqId, false, undefined, undefined, at);
      await onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="close-reason-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      role="presentation"
    >
      <div
        className="close-reason-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Reactivate deal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="close-reason-title">Reactivate this deal</div>
        <div className="close-reason-sub">
          The deal returns to its pipeline column and the close reason is cleared.
          {closed ? ` It was closed on ${closed.replace("T", " ")}.` : ""} The reactivation is
          recorded in the activity log with the date below.
        </div>
        <DateTimeField label="Reactivated on" value={at} onChange={setAt} />
        {beforeClose ? (
          <div className="close-reason-warn">The date is earlier than the close date.</div>
        ) : null}
        <div className="close-reason-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={save}
            disabled={busy || !at || beforeClose}
          >
            {busy ? "Saving…" : "Reactivate"}
          </button>
        </div>
      </div>
    </div>
  );
}
