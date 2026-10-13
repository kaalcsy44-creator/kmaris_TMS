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
