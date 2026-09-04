"use client";

// 선택한 품목 줄에 같은 값을 한 번에 채운다 — 제조사 · 등급 · 분류.
//
// 문의 한 통에 부품이 쉰 줄씩 들어온다. 그런데 그 쉰 줄은 대개 한 엔진의 예비품이라
// 제조사도 등급도 같다. 같은 값을 쉰 번 고르게 두면 아무도 고르지 않고, 그 칸은 빈 채로
// 2단계로 넘어간다 — 칸을 만든 뜻이 거기서 사라진다.
//
// 줄이 하나도 안 골라졌으면 이 줄은 아예 뜨지 않는다. 늘 자리를 지키면 "지금 무엇에
// 적용되는가"가 흐려지고, 실수로 엉뚱한 줄을 덮는 길이 열린다.
//
// 고르는 즉시 적용한다. 고른 뒤 다시 [적용] 을 눌러야 하면 한 번에 하려던 일이 두 번이
// 되고, 무엇보다 눌렀는지 안 눌렀는지가 화면에 남지 않는다. 되돌리기는 Cancel 이다 —
// 저장 전이라 표를 되돌리면 그만이다.

import { useState } from "react";
import MakerCell from "@/components/common/MakerCell";
import { ITEM_GRADES } from "@/components/common/GradeCell";
import { useCategoryOptions } from "@/components/common/CategoryCell";

export default function ItemBulkFill({
  count,
  onMaker,
  onGrade,
  onCategory,
  onClear,
  disabled,
}: {
  /** 지금 선택된 줄 수. 0 이면 아무것도 그리지 않는다. */
  count: number;
  onMaker?: (v: string) => void;
  onGrade?: (v: string) => void;
  onCategory?: (id: number | null) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  // 제조사는 글자 입력이라 화면 값이 필요하다(고르거나 Enter 를 쳐야 적용된다).
  const [maker, setMaker] = useState("");
  const cats = useCategoryOptions();
  // 고르는 칸은 늘 "Set…"(빈 값)으로 되돌아가 있으므로, 비우기를 빈 값으로 두면 골라도
  // onChange 가 울리지 않는다(값이 안 바뀐 것이라서). 그래서 비우기에 제 표를 준다.
  const CLEAR = "--clear--";

  if (count <= 0) return null;

  function applyMaker(v: string) {
    onMaker?.(v);
    setMaker("");
  }

  return (
    <div className="ibf">
      <span className="ibf-n">
        <b>{count}</b> {count === 1 ? "row" : "rows"} selected — set
      </span>

      {onMaker ? (
        <label className="ibf-f">
          <span>Maker</span>
          <div className="ibf-maker">
            <MakerCell
              value={maker}
              onChange={setMaker}
              onCommit={applyMaker}
              disabled={disabled}
              placeholder="Pick or type…"
            />
          </div>
        </label>
      ) : null}

      {onGrade ? (
        <label className="ibf-f">
          <span>Grade</span>
          <select
            className="ibf-sel"
            value=""
            disabled={disabled}
            onChange={(e) => {
              if (!e.target.value) return;
              onGrade(e.target.value === CLEAR ? "" : e.target.value);
            }}
          >
            <option value="">Set…</option>
            {/* 비우는 길도 남긴다 — 잘못 채운 뒤 지울 방법이 없으면 한 줄씩 다시 손봐야 한다. */}
            <option value={CLEAR}>— Clear —</option>
            {ITEM_GRADES.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </label>
      ) : null}

      {onCategory ? (
        <label className="ibf-f ibf-f--wide">
          <span>Category</span>
          <select
            className="ibf-sel"
            value=""
            disabled={disabled}
            onChange={(e) => {
              if (!e.target.value) return;
              onCategory(e.target.value === CLEAR ? null : Number(e.target.value));
            }}
          >
            <option value="">Set…</option>
            <option value={CLEAR}>— Clear —</option>
            {cats.map((o) => (
              <option key={o.id} value={o.id}>{o.path}</option>
            ))}
          </select>
        </label>
      ) : null}

      <button type="button" className="btn sm ibf-clear" onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}
