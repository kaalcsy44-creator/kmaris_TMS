"use client";

// 프로젝트 카드에서 연결된 vendor를 "색상 이니셜 모노그램"으로 표시한다.
// 벤더 로고 커버리지가 부분적(업로드된 것만)이라 로고 대신 이니셜 원형 배지를 쓰고,
// 전체 이름은 hover 툴팁으로 제공한다. 여러 vendor(vrfq_vendors는 "\n", PO vendor는
// "," 로 연결)를 분리해 최대 MAX개만 배지로 보여주고 나머지는 +N 으로 접는다.

const MAX = 3;

/** "\n" 또는 "," 로 이어진 vendor 문자열을 개별 이름으로 분리(중복 제거). */
function splitVendors(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[\n,]/)) {
    const n = raw.trim();
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** vendor 이름 → 1~2글자 이니셜. 여러 단어면 앞 두 단어 첫 글자, 한 단어면 앞 두 글자. */
function initials(name: string): string {
  const words = name.replace(/[()[\]]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** 이름 → 안정적인 색상(Hue). 같은 vendor 는 항상 같은 색으로 렌더된다. */
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export default function VendorMonograms({
  value,
  statuses,
  className,
}: {
  value?: string;
  // 견적 수신여부까지 주면(Quote 단계): 제출 벤더=진한 배지, 미제출=흐린 고스트 배지.
  statuses?: { name: string; quoted: boolean }[];
  className?: string;
}) {
  // statuses 가 있으면 제출(quoted) 벤더를 앞으로 정렬해 우선 노출한다.
  const entries: { name: string; quoted: boolean }[] =
    statuses && statuses.length
      ? [...statuses].sort((a, b) => Number(b.quoted) - Number(a.quoted))
      : splitVendors(value || "").map((n) => ({ name: n, quoted: true }));
  if (entries.length === 0) return null;
  const shown = entries.slice(0, MAX);
  const extra = entries.length - shown.length;
  const label = entries
    .map((e) => (e.quoted ? e.name : `${e.name} (견적 미수신)`))
    .join(", ");
  return (
    <span
      className={`vendor-mono-wrap${className ? ` ${className}` : ""}`}
      title={`Vendor: ${label}`}
    >
      {shown.map((e, i) => (
        <span
          key={i}
          className={`vendor-mono${e.quoted ? "" : " ghost"}`}
          style={e.quoted ? { backgroundColor: `hsl(${hueFor(e.name)} 48% 40%)` } : undefined}
          title={e.quoted ? e.name : `${e.name} — RFQ 발송·견적 미수신`}
        >
          {initials(e.name)}
        </span>
      ))}
      {extra > 0 ? (
        <span
          className="vendor-mono more"
          title={entries.slice(MAX).map((e) => (e.quoted ? e.name : `${e.name} (견적 미수신)`)).join(", ")}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
