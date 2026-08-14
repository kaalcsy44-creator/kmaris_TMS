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

/** 활동기록 저장 payload. 폼과 같은 파일에 둔다 — 쓰는 화면마다 모양이 갈라지지 않게. */
export type NotePatch = {
  text: string;
  datetime?: string;
  direction?: string;
  party?: string;
  person?: string;
  channel?: string;
  star?: boolean;
  pic?: string;
};

/** 폼 값 → 저장 payload. 빈 값은 보내지 않아 서버가 '미지정'으로 남긴다. */
export function noteFormToPatch(v: ActivityNoteValue): NotePatch {
  return {
    text: v.text.trim(),
    datetime: v.datetime,
    direction: v.direction || undefined,
    party: v.party || undefined,
    person: v.person || undefined,
    channel: v.channel || undefined,
    star: v.star,
    pic: v.pic.trim() || undefined,
  };
}

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
  dialog = false,
}: {
  value: ActivityNoteValue;
  onChange: (v: ActivityNoteValue) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel?: string;
  busy?: boolean;
  partyPresets?: string[]; // Party 후보 — 이 딜의 고객사·벤더사명(deal.activityParties)
  personPresets?: string[]; // Person 후보 — 이 딜의 고객/벤더 담당자(deal.activityPersons)
  // dialog: 팝업 배치 — 칸마다 제목을 달고 앱 표준 폼(form-grid·form-field)으로 놓는다.
  // 목록 안에 끼워 넣는 기본 배치는 폭이 없어 제목을 못 달고 placeholder 로 대신하는데,
  // 팝업에는 그럴 이유가 없다(줄바꿈이 제멋대로 나던 것도 그래서다).
  dialog?: boolean;
}) {
  const picOptions = usePicOptions(value.pic);
  const set = <K extends keyof ActivityNoteValue>(k: K, v: ActivityNoteValue[K]) =>
    onChange({ ...value, [k]: v });

  // 칸은 한 벌만 만들고 배치만 둘로 나눈다 — 두 벌로 두면 화면마다 남길 수 있는
  // 정보가 갈라진다(이 파일이 애초에 하나로 모인 이유).
  const whenField = (
    // 일시 — 네이티브 datetime-local(숫자 직접입력). 날짜·시각을 키보드로 바로 친다.
    <input
      type="datetime-local"
      value={value.datetime}
      title="Activity time"
      onChange={(e) => set("datetime", e.target.value)}
    />
  );
  const dirField = (
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
  );
  const partyField = (
    <PresetSelect
      value={value.party}
      onChange={(v) => set("party", v)}
      placeholder={dialog ? "—" : "Party —"}
      presets={partyPresets}
    />
  );
  const personField = (
    <PresetSelect
      value={value.person}
      onChange={(v) => set("person", v)}
      placeholder={dialog ? "—" : "Person —"}
      presets={personPresets}
    />
  );
  const channelField = (
    <PresetSelect
      value={value.channel}
      onChange={(v) => set("channel", v)}
      placeholder={dialog ? "—" : "Channel —"}
      presets={CHANNEL_PRESETS}
    />
  );
  const picField = (
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
  );
  const starField = (
    <label className="act-check">
      <input type="checkbox" checked={value.star} onChange={(e) => set("star", e.target.checked)} />
      {dialog ? " ★ priority" : " ★"}
    </label>
  );
  // 내용 — Enter=저장, Shift+Enter=줄바꿈. 팝업은 폭이 있으니 몇 줄 더 준다.
  const textField = (
    <textarea
      className="act-add-text"
      placeholder="Activity note (e.g. Waiting for PO / requested update)"
      value={value.text}
      rows={dialog ? 4 : 2}
      onChange={(e) => set("text", e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
        if (e.key === "Escape") onCancel();
      }}
      autoFocus
    />
  );
  const submitBtn = (label: string) => (
    <button
      type="button"
      className={`btn ${dialog ? "primary" : "sm primary act-add-go"}`}
      disabled={busy || !value.text.trim()}
      onClick={onSubmit}
    >
      {busy ? "…" : label}
    </button>
  );

  if (dialog) {
    return (
      <div className="act-add act-add--dialog">
        <div className="form-grid">
          <div className="form-field">
            <label>When</label>
            {whenField}
          </div>
          {/* 방향과 ★ 는 한 칸에 — 둘 다 값이 아니라 표시라, 입력칸 사이에 끼면 눈이 걸린다. */}
          <div className="form-field">
            <label>Direction</label>
            <div className="act-add-dirline">
              {dirField}
              {starField}
            </div>
          </div>
          <div className="form-field">
            <label>Party</label>
            {partyField}
          </div>
          <div className="form-field">
            <label>Person</label>
            {personField}
          </div>
          <div className="form-field">
            <label>Channel</label>
            {channelField}
          </div>
          <div className="form-field">
            <label>PIC</label>
            {picField}
          </div>
        </div>
        <div className="form-field act-note-field">
          <label>Note</label>
          {textField}
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          {submitBtn(submitLabel)}
        </div>
      </div>
    );
  }

  return (
    <div className="act-add">
      {/* 1행: 일시 · From/To · Party · Channel · 담당자 · ★ */}
      <div className="act-add-row">
        {whenField}
        {dirField}
        {partyField}
        {personField}
        {channelField}
        {picField}
        {starField}
      </div>
      {/* 2행: 내용 */}
      <div className="act-add-row">{textField}</div>
      {/* 3행: 저장 · 취소 */}
      <div className="act-add-row">
        {submitBtn(submitLabel)}
        <button type="button" className="btn sm act-add-go" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
