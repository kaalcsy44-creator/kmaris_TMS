"use client";

// 상세 모달(2·4·6단계)의 두 탭: Detail(시스템 입력·편집) / Email(문서 생성·발송).
export type DetailTab = "edit" | "email";

export default function DetailTabBar({
  tab,
  onTab,
}: {
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
}) {
  return (
    <div className="detail-tabs" role="tablist">
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
    </div>
  );
}
