"use client";

// 담당자 등급 배지 — 이 사람과 우리 사이에 무엇이 오갔는가.
//
// 등급은 서버가 매긴다(_core.customer_grades). 화면이 다시 세지 않는 까닭은, 세는
// 자리가 둘이 되면 어느 날 둘이 다른 말을 하기 때문이다.
//
//   X  닿지 않는 사람        — 등록된 주소가 전부 반송됐다(고칠 대상, 등급 밖)
//   S  거래까지 간 사람      — 고객 P/O 를 준 적이 있다
//   A  문의를 준 사람        — RFQ 가 들어왔다
//   B  답장은 준 사람        — 사람이 쓴 회신이 왔다(자동응답은 치지 않는다)
//   C  아직 답이 없는 사람   — 보내기만 했고 사람의 답은 돌아온 것이 없다
//
// 고르기 목록(CustomerSelect)과 마케팅 목록의 Contact 칸이 같은 배지를 쓴다. 한쪽에서
// 본 표시를 다른 쪽에서 못 알아보면 표시가 아니라 장식이 된다.

import { useMemo } from "react";
import { fetchCustomers } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { CustomerGrade } from "@/lib/types";

/** 배지는 글자 한 자뿐이라 뜻은 툴팁이 진다. */
export const GRADE_HINT: Record<CustomerGrade, string> = {
  X: "Unreachable — every address on file bounced. Fix the address or drop this contact.",
  S: "Ordered before — this contact has given us a P/O",
  A: "Sent an inquiry (RFQ)",
  B: "Replied to our mail, but no inquiry yet (auto-replies do not count)",
  C: "No reply yet — auto-reply only, or nothing came back",
};

export function GradeBadge({ grade }: { grade?: CustomerGrade | null }) {
  if (!grade) return null;
  return (
    <span className={`cust-grade g-${grade}`} title={GRADE_HINT[grade]}>
      {grade}
    </span>
  );
}

/** 담당자 id → 등급. 고객 목록 캐시를 그대로 읽는다(이미 여러 화면이 쓰는 그 캐시다). */
export function useCustomerGrade(): (customerId?: number | null) => CustomerGrade | undefined {
  const { data } = useCachedData("settings:customers", fetchCustomers);
  const byId = useMemo(() => {
    const m = new Map<number, CustomerGrade>();
    for (const c of data ?? []) if (c.grade) m.set(c.id, c.grade);
    return m;
  }, [data]);
  return (customerId) => (customerId ? byId.get(customerId) : undefined);
}
