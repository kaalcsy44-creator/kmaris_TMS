/** 서버 Content-Disposition 에서 파일명을 꺼낸다 — filename*(UTF-8) 우선, 없으면 filename.
 *  서버는 발행 문서를 문서번호로 이름 붙인다(EHZM-26-0059-PI.pdf). 못 읽으면 fallback. */
export function filenameFromDisposition(res: Response, fallback: string): string {
  const d = res.headers.get("content-disposition") || "";
  const star = d.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* 아래 filename 으로 */
    }
  }
  const plain = d.match(/filename\s*=\s*"([^"]+)"/i) || d.match(/filename\s*=\s*([^;]+)/i);
  return plain?.[1]?.trim() || fallback;
}

/** 발행 문서 파일명 — "문서번호 선박명.ext"(KMS-QUO-2611-001 HELENE MAERSK.pdf).
 *  선박이 없거나 "—"면 문서번호만. suffix 는 선박명 뒤에 붙는다(Vendor RFQ 의 _벤더명). */
export function docFileName(docNo: string, vessel: string | null | undefined, ext: string, suffix = ""): string {
  const v = (vessel || "").trim();
  const name = v && v !== "—" && v !== "-" ? `${docNo} ${v}` : docNo;
  return `${name}${suffix}.${ext}`.replace(/[\/:*?"<>|\r\n]+/g, "-");
}
