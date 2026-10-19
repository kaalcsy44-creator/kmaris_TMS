"use client";

import { useEffect, useMemo, useState } from "react";
import Modal from "@/components/common/Modal";
import {
  buildDealSummary,
  DEFAULT_SUMMARY_OPTIONS,
  SUMMARY_FIELDS,
  SUMMARY_GROUPS,
  type SummaryDeal,
  type SummaryFieldKey,
  type SummaryGroupKey,
  type SummaryOptions,
} from "@/lib/dealSummary";

// 딜 현황 요약 — 고른 항목만 글로 뽑아 카톡·메일에 붙인다. 왼쪽은 무엇을 넣을지,
// 오른쪽은 지금 고른 대로 나올 글 그대로. 미리보기가 곧 복사될 글이어야 고르는 손이
// 결과를 보면서 움직인다.
//
// 고른 값은 기억한다(마지막 값 + 이름 붙인 프리셋). 매주 같은 꼴로 보내는 보고라
// 열 때마다 체크를 다시 하게 하면 안 된다.

const LAST_KEY = "ktms.dealSummary.last";
const PRESETS_KEY = "ktms.dealSummary.presets";

type Preset = { name: string; opt: SummaryOptions };

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장 실패 — 이번 창에서만 적용된다 */
  }
}

/** 옛 저장값에 없는 키는 기본값으로 메운다(항목이 늘어도 깨지지 않게). */
function normalize(o: Partial<SummaryOptions> | null | undefined): SummaryOptions {
  return { ...DEFAULT_SUMMARY_OPTIONS, ...(o ?? {}) };
}

export default function DealSummaryModal({
  openDeals,
  briefingDeals,
  briefingLabel,
  steps,
  onClose,
}: {
  openDeals: SummaryDeal[];       // 취소 아닌 전체 딜
  briefingDeals: SummaryDeal[];   // 브리핑에 지금 보이는 카드(필터 반영)
  briefingLabel: string;          // 지금 필터 이름(예: "Our move")
  steps: string[];
  onClose: () => void;
}) {
  const [opt, setOpt] = useState<SummaryOptions>(DEFAULT_SUMMARY_OPTIONS);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    setOpt(normalize(readJson<Partial<SummaryOptions> | null>(LAST_KEY, null)));
    setPresets(readJson<Preset[]>(PRESETS_KEY, []));
  }, []);

  function update(patch: Partial<SummaryOptions>) {
    setOpt((cur) => {
      const next = { ...cur, ...patch };
      writeJson(LAST_KEY, next);
      return next;
    });
    setCopied("");
  }

  function toggleField(k: SummaryFieldKey) {
    const has = opt.fields.includes(k);
    // 순서는 SUMMARY_FIELDS 순서로 고정 — 고른 순서대로 쌓이면 프리셋마다 줄 순서가 달라진다.
    const next = SUMMARY_FIELDS.map((f) => f.key).filter((x) => (x === k ? !has : opt.fields.includes(x)));
    update({ fields: next });
  }
  function toggleGroup(k: SummaryGroupKey) {
    const has = opt.groups.includes(k);
    update({ groups: SUMMARY_GROUPS.map((g) => g.key).filter((x) => (x === k ? !has : opt.groups.includes(x))) });
  }

  const source = opt.scope === "briefing" ? briefingDeals : openDeals;
  const pics = useMemo(
    () => Array.from(new Set(openDeals.map((d) => d.row.assignee).filter(Boolean))).sort(),
    [openDeals]
  );
  const result = useMemo(() => buildDealSummary(source, steps, opt), [source, steps, opt]);

  async function copy() {
    try {
      if (result.html && typeof ClipboardItem !== "undefined") {
        // 메일 형식은 서식째 — Gmail·Outlook 에 붙이면 굵기·색이 산다. 메모장 같은 곳에
        // 붙이면 text/plain 쪽이 들어간다.
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([result.html], { type: "text/html" }),
            "text/plain": new Blob([result.text], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(result.text);
      }
      setCopied("Copied");
    } catch {
      setCopied("Copy failed — select the text and copy manually");
    }
  }

  function download() {
    const blob = new Blob([result.text.replace(/\n/g, "\r\n")], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `KTMS_Deal_Summary_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function savePreset() {
    const name = presetName.trim();
    if (!name) return;
    const next = [...presets.filter((p) => p.name !== name), { name, opt }];
    setPresets(next);
    writeJson(PRESETS_KEY, next);
    setPresetName("");
  }
  function removePreset(name: string) {
    const next = presets.filter((p) => p.name !== name);
    setPresets(next);
    writeJson(PRESETS_KEY, next);
  }

  return (
    <Modal title="Deal summary" onClose={onClose} maxWidth={1080}>
      <div className="dsum">
        <div className="dsum-opts">
          <fieldset>
            <legend>Format</legend>
            <Seg
              value={opt.format}
              choices={[["kakao", "KakaoTalk"], ["email", "Email"]]}
              onPick={(v) => update({ format: v as SummaryOptions["format"] })}
            />
          </fieldset>

          <fieldset>
            <legend>Deals</legend>
            <Seg
              value={opt.scope}
              choices={[["open", "All active"], ["briefing", `Briefing · ${briefingLabel}`]]}
              onPick={(v) => update({ scope: v as SummaryOptions["scope"] })}
            />
            <label className="dsum-chk">
              <input
                type="checkbox"
                checked={opt.includeSettled}
                onChange={(e) => update({ includeSettled: e.target.checked })}
              />
              Include settled (payment completed)
            </label>
            <label className="dsum-row">
              <span>PIC</span>
              <select value={opt.pic} onChange={(e) => update({ pic: e.target.value })}>
                <option value="">All</option>
                {pics.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </fieldset>

          <fieldset>
            <legend>Stages</legend>
            <div className="dsum-grid">
              {SUMMARY_GROUPS.map((g) => (
                <label key={g.key} className="dsum-chk" title={`Stage ${g.stages.filter(Boolean).join("·")}`}>
                  <input type="checkbox" checked={opt.groups.includes(g.key)} onChange={() => toggleGroup(g.key)} />
                  {g.label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Fields</legend>
            <div className="dsum-grid">
              {SUMMARY_FIELDS.map((f) => (
                <label key={f.key} className="dsum-chk">
                  <input type="checkbox" checked={opt.fields.includes(f.key)} onChange={() => toggleField(f.key)} />
                  {f.label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Presets</legend>
            {presets.length ? (
              <div className="dsum-presets">
                {presets.map((p) => (
                  <span key={p.name} className="dsum-preset">
                    <button type="button" onClick={() => update(normalize(p.opt))}>{p.name}</button>
                    <button type="button" className="x" aria-label={`Delete ${p.name}`} onClick={() => removePreset(p.name)}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="dsum-row">
              <input
                value={presetName}
                placeholder="Preset name (e.g. 주간보고)"
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") savePreset(); }}
              />
              <button type="button" className="btn sm" disabled={!presetName.trim()} onClick={savePreset}>Save</button>
            </div>
            <button type="button" className="dsum-reset" onClick={() => update(DEFAULT_SUMMARY_OPTIONS)}>
              Reset to default
            </button>
          </fieldset>
        </div>

        <div className="dsum-preview">
          <div className="dsum-preview-head">
            <span>{result.count} deals</span>
            <span className="dsum-actions">
              {copied ? <span className="dsum-copied">{copied}</span> : null}
              <button type="button" className="btn sm" onClick={download} disabled={!result.count}>.txt</button>
              <button type="button" className="btn sm primary" onClick={copy}>Copy</button>
            </span>
          </div>
          <pre className="dsum-text">{result.text}</pre>
        </div>
      </div>
    </Modal>
  );
}

function Seg({
  value,
  choices,
  onPick,
}: {
  value: string;
  choices: [string, string][];
  onPick: (v: string) => void;
}) {
  return (
    <span className="dsum-seg" role="group">
      {choices.map(([v, label]) => (
        <button key={v} type="button" className={value === v ? "on" : ""} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </span>
  );
}
