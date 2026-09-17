"use client";

import { useState } from "react";
import { CLOSE_REASONS, setRfqCancelled } from "@/lib/api";

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
  onSaved,
  onClose,
}: {
  rfqId: number;
  mode?: "close" | "edit";
  initialCode?: string | null;
  initialNote?: string | null;
  /** 저장 후 목록·화면을 다시 읽는다. */
  onSaved: () => void | Promise<unknown>;
  onClose: () => void;
}) {
  const [code, setCode] = useState(initialCode || "");
  const [note, setNote] = useState(initialNote || "");
  const [busy, setBusy] = useState(false);
  const editing = mode === "edit";
  // 'Other' 는 노트가 곧 사유라 비워 둘 수 없다. 그 밖의 갈래는 노트가 덧붙임(선택).
  const ready = !!code && (code !== "other" || !!note.trim());

  async function save() {
    if (busy || !ready) return;
    setBusy(true);
    try {
      await setRfqCancelled(rfqId, true, code, note.trim() || undefined);
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
            ? "The deal stays closed — only the reason changes. Nothing is added to the activity log."
            : "Select a reason. It will move to the Closed zone on the board — you can reactivate it anytime."}
        </div>
        <div className="close-reason-list">
          {CLOSE_REASONS.map((opt) => (
            <label key={opt.code} className={`close-reason-opt${code === opt.code ? " sel" : ""}`}>
              <input
                type="radio"
                name="close-reason"
                value={opt.code}
                checked={code === opt.code}
                onChange={() => setCode(opt.code)}
              />
              <span className={`close-badge tone-${opt.tone}`}>{opt.badge}</span>
              <span className="close-reason-txt">{opt.label}</span>
            </label>
          ))}
        </div>
        {/* 갈래로는 다 담기지 않는 사정(어느 메이커가·얼마나 비쌌는지)은 여기 남는다.
            갈래는 세기 위한 것이고, 이 글은 다음에 같은 고객을 만났을 때 읽을 것이다. */}
        {code ? (
          <textarea
            className="close-reason-note"
            placeholder={code === "other" ? "Enter the reason" : "Add a note (optional)"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            autoFocus
          />
        ) : null}
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
