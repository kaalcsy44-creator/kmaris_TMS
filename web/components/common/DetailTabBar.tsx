"use client";

// 상세 모달(2·4·6단계)의 탭: Detail(시스템 입력·편집) / Email(문서 생성·발송).
// 4단계는 여기에 Proforma Invoice 한 칸이 더 붙는다(pi) — 선급금 청구용 PI 를 견적과
// 함께 내보내는 자리다. 그 문서는 7단계의 Proforma Invoice 와 같은 한 장이다.
export type DetailTab = "edit" | "email" | "pi";

export default function DetailTabBar({
  tab,
  onTab,
  pi,
}: {
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  /** Proforma Invoice 탭 노출 여부(4단계에서만 켠다). */
  pi?: boolean;
}) {
  return (
    <div className="pane-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === "edit"}
        className={tab === "edit" ? "on" : ""}
        onClick={() => onTab("edit")}
      >
        ✎ Detail
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "email"}
        className={tab === "email" ? "on" : ""}
        onClick={() => onTab("email")}
      >
        ✉ Email
      </button>
      {pi ? (
        <button
          type="button"
          role="tab"
          aria-selected={tab === "pi"}
          className={tab === "pi" ? "on" : ""}
          onClick={() => onTab("pi")}
        >
          🧾 Proforma Invoice
        </button>
      ) : null}
    </div>
  );
}
