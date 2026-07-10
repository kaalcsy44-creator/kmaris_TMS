/** 문서번호(견적·PO·RFQ) 오름차순 정렬 — 숫자가 빠른 순으로 좌→우 배치.
 *  번호가 있는 건을 자연 정렬(numeric)로 앞에 두고, 번호가 없는 건은 뒤로 밀어
 *  id 순으로 안정적으로 정렬한다. */
export function sortByDocNo<T>(
  rows: T[],
  docNo: (r: T) => string | null | undefined,
  id: (r: T) => number
): T[] {
  return [...rows].sort((a, b) => {
    const na = (docNo(a) || "").trim();
    const nb = (docNo(b) || "").trim();
    if (na && nb) return na.localeCompare(nb, undefined, { numeric: true });
    if (na) return -1;
    if (nb) return 1;
    return id(a) - id(b);
  });
}
