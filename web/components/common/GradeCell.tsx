"use client";

// 품목표 셀용 부품 등급(Genuine / OEM / …) 선택.
//
// 제조사(Maker) 바로 옆에 서는 칸이다. 둘은 한 질문의 두 쪽이라서다 — "누가 만든
// 것인가"와 "그 회사 상표를 달고 나온 것인가". YANMAR 부품을 달라는 문의에도 정품
// 상자를 원하는 건과 같은 공장에서 나온 OEM 이면 되는 건이 있고, 값은 배로 갈린다.
// 이 답을 1단계에서 받아 두지 않으면 2단계 Vendor RFQ 를 쓸 때 다시 물어야 한다.
//
// 제조사와 달리 여기는 **닫힌 목록**이다. 세상의 제조사는 우리 명부보다 늘 넓지만
// 등급은 다섯 마디가 전부이고, 같은 뜻을 저마다 다르게 적어 두면(genuine/Genuine/
// 정품/GEN) 나중에 이 칸으로 무엇을 가려낼 수가 없다.

export const ITEM_GRADES = [
  "Genuine",
  "OEM",
  "Aftermarket",
  "Reconditioned",
  "Used",
] as const;

/** 좁은 칸에서도 무엇인지 알 수 있게 — 고른 값의 뜻을 툴팁으로 붙인다. */
const GRADE_HINT: Record<string, string> = {
  Genuine: "Maker's own branded part",
  OEM: "Made by the original factory, not in the maker's box",
  Aftermarket: "Compatible part from another manufacturer",
  Reconditioned: "Overhauled / refurbished",
  Used: "Second-hand",
};

export default function GradeCell({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const known = (ITEM_GRADES as readonly string[]).includes(value);
  return (
    <select
      className="grade-cell"
      value={value}
      disabled={disabled}
      title={GRADE_HINT[value] || "Genuine / OEM / Aftermarket — what the customer is asking for"}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {/* 목록에 없는 값이 저장돼 있으면(예전 데이터·외부 입력) 자리를 남긴다 —
          고르지 않았을 뿐인데 조용히 지워지면 안 된다. */}
      {value && !known ? <option value={value}>{value}</option> : null}
      {ITEM_GRADES.map((g) => (
        <option key={g} value={g}>
          {g}
        </option>
      ))}
    </select>
  );
}
