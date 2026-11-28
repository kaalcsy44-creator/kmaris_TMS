/** 라인 ID 묶음을 짧게 — ["L01","L02","L03","L32"] → "L01–L03, L32".
 *  같은 공급사에 여러 번 물은 딜에서 어느 RFQ·견적인지 가리는 꼬리표로 쓴다
 *  (견적 비교표 머리칸, 4단계 Load vendor quotes). 중복은 한 번만 센다. */
export function compactLids(lids: (string | null | undefined)[]): string {
  const nums = new Map<number, number>();   // 번호 → 자릿수(L01 처럼 0 을 채운 꼴 그대로)
  const other: string[] = [];
  for (const raw of lids) {
    const id = (raw || "").trim();
    if (!id) continue;
    const m = /^L(\d+)$/i.exec(id);
    if (m) nums.set(Number(m[1]), Math.max(nums.get(Number(m[1])) ?? 0, m[1].length));
    else if (!other.includes(id)) other.push(id);
  }
  const seq = [...nums.entries()].sort((a, b) => a[0] - b[0]);
  const fmt = ([n, w]: [number, number]) => `L${String(n).padStart(w, "0")}`;
  const parts: string[] = [];
  for (let i = 0; i < seq.length; ) {
    let j = i;
    while (j + 1 < seq.length && seq[j + 1][0] === seq[j][0] + 1) j++;
    parts.push(i === j ? fmt(seq[i]) : `${fmt(seq[i])}–${fmt(seq[j])}`);
    i = j + 1;
  }
  return [...parts, ...other].join(", ");
}
