"use client";

import { useMemo, useState } from "react";
import { fetchAssignableUsers } from "@/lib/api";
import { getUser } from "@/lib/auth";
import { useCachedData } from "@/lib/useCachedData";

// 활동기록(stage note) 입력 폼 — Activity 페이지(신규·수정)와 Progress 편집창이 공유한다.
// 세 곳이 같은 stage_notes 에 쓰는데 폼이 제각각이면 화면마다 남길 수 있는 정보가 달라진다
// (담당자·★ 가 있는 곳과 없는 곳). 한 컴포넌트로 모아 어디서 쓰든 같은 항목을 남긴다.
//
// 일시는 분 단위(datetime-local). 예전 Activity 폼은 날짜만 받고 09:00 을 박아 넣었는데,
// Progress 목록은 시각을 표시하므로(fmtStageDate) 그 값이 그대로 보인다 — 분 단위로 통일했다.

export type ActivityNoteValue = {
  text: string;
  datetime: string;   // "YYYY-MM-DDTHH:MM"
  direction: "" | "in" | "out";
  party: string;
  person: string;     // 소통 상대 담당자(고객/벤더 담당자명 또는 직접입력)
  channel: string;
  star: boolean;
  pic: string;
};

const CHANNEL_PRESETS = ["Email", "Message", "Call"];

/** datetime-local 기본값(현재 시각, 분 단위) "YYYY-MM-DDTHH:MM". */
export function nowLocalInput(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 저장된 값("…T09:00" 또는 날짜만) → datetime-local 이 받는 "YYYY-MM-DDTHH:MM". */
export function toLocalInput(iso: string | undefined | null): string {
  const s = (iso || "").trim();
  if (!s) return nowLocalInput();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return nowLocalInput();
  return m[2] ? `${m[1]}T${m[2]}:${m[3]}` : `${m[1]}T09:00`;
}

/** 담당자(PIC) 드롭다운 후보 — 배정 가능 사용자(+ 로그인 사용자, + 현재 선택값). 공유 캐시. */
export function usePicOptions(current: string): string[] {
  const me = getUser();
  const { data: users } = useCachedData("assignable-users", fetchAssignableUsers);
  return useMemo(() => {
    const set = new Set<string>();
    if (me?.username) set.add(me.username);
    (users ?? []).forEach((u) => set.add(u.username));
    if (current) set.add(current);
    return Array.from(set);
  }, [users, me?.username, current]);
}

// Party / Channel 선택 — 프리셋 + '직접입력'(자유 텍스트, 영문). 두 필드가 동일 구조라 공용.
function PresetSelect({
  value,
  onChange,
  placeholder,
  presets,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string; // 예: "Party —" / "Channel —"
  presets: string[];
}) {
  // 값이 있고 프리셋이 아니면 직접입력 모드로 시작.
  const [custom, setCustom] = useState(() => !!value && !presets.includes(value));
  return (
    <>
      <select
        value={custom ? "__custom__" : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__custom__") { setCustom(true); onChange(""); }
          else { setCustom(false); onChange(v); }
        }}
      >
        <option value="">{placeholder}</option>
        {presets.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
        <option value="__custom__">직접입력</option>
      </select>
      {custom ? (
        <input
          className="act-party-custom"
          type="text"
          value={value}
          placeholder={placeholder.replace(/\s*—\s*$/, "")}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </>
  );
}

/** 초기값 — initial 이 없으면 신규(지금 시각·로그인 사용자). */
export function initialNoteValue(initial?: Partial<ActivityNoteValue> | null): ActivityNoteValue {
  return {
    text: initial?.text ?? "",
    datetime: toLocalInput(initial?.datetime),
    direction: (initial?.direction as "" | "in" | "out") ?? "",
    party: initial?.party ?? "",
    person: initial?.person ?? "",
    channel: initial?.channel ?? "",
    star: !!initial?.star,
    pic: initial?.pic ?? (getUser()?.username ?? ""),
  };
}

export default function ActivityNoteForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel = "Add",
  busy = false,
  partyPresets = [],
  personPresets = [],
}: {
  value: ActivityNoteValue;
  onChange: (v: ActivityNoteValue) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel?: string;
  busy?: boolean;
  partyPresets?: string[]; // Party 후보 — 이 딜의 고객사·벤더사명(deal.activityParties)
  personPresets?: string[]; // Person 후보 — 이 딜의 고객/벤더 담당자(deal.activityPersons)
}) {
  const picOptions = usePicOptions(value.pic);
  const set = <K extends keyof ActivityNoteValue>(k: K, v: ActivityNoteValue[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="act-add">
      {/* 1행: 일시 · From/To · Party · Channel · 담당자 · ★ */}
      <div className="act-add-row">
        {/* 일시 — 네이티브 datetime-local(숫자 직접입력). 날짜·시각을 키보드로 바로 친다. */}
        <input
          type="datetime-local"
          value={value.datetime}
          title="Activity time"
          onChange={(e) => set("datetime", e.target.value)}
        />
        <div className="act-seg sm">
          {(["in", "out"] as const).map((d) => (
            <button
              key={d}
              type="button"
              className={value.direction === d ? "on" : ""}
              onClick={() => set("direction", value.direction === d ? "" : d)}
              title={d === "in" ? "Received (수신)" : "Sent (발신)"}
            >
              {d === "in" ? "From" : "To"}
            </button>
          ))}
        </div>
        <PresetSelect
          value={value.party}
          onChange={(v) => set("party", v)}
          placeholder="Party —"
          presets={partyPresets}
        />
        <PresetSelect
          value={value.person}
          onChange={(v) => set("person", v)}
          placeholder="Person —"
          presets={personPresets}
        />
        <PresetSelect
          value={value.channel}
          onChange={(v) => set("channel", v)}
          placeholder="Channel —"
          presets={CHANNEL_PRESETS}
        />
        <select
          className="act-add-pic"
          value={value.pic}
          title="담당자(작성자)"
          onChange={(e) => set("pic", e.target.value)}
        >
          {value.pic ? null : <option value="">PIC —</option>}
          {picOptions.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
        <label className="act-check">
          <input type="checkbox" checked={value.star} onChange={(e) => set("star", e.target.checked)} /> ★
        </label>
      </div>
      {/* 2행: 내용 — Enter=저장, Shift+Enter=줄바꿈. */}
      <div className="act-add-row">
        <textarea
          className="act-add-text"
          placeholder="Activity note (e.g. Waiting for PO / requested update)"
          value={value.text}
          rows={2}
          onChange={(e) => set("text", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
            if (e.key === "Escape") onCancel();
          }}
          autoFocus
        />
      </div>
      {/* 3행: 저장 · 취소 */}
      <div className="act-add-row">
        <button
          type="button"
          className="btn sm primary act-add-go"
          disabled={busy || !value.text.trim()}
          onClick={onSubmit}
        >
          {busy ? "…" : submitLabel}
        </button>
        <button type="button" className="btn sm act-add-go" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
