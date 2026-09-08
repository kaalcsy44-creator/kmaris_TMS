"use client";

/**
 * 반송 주소 표시 — 보냈다가 "Address not found"로 되돌아온 주소.
 *
 * 마케팅 활동 창에서 한 번 체크하면 그 표시가 주소를 따라 고객 담당자 명부와 홍보
 * 메일 작성 화면까지 함께 간다. 반송은 그 발송 한 건의 사정이 아니라 주소의 사정이라,
 * 다음에 누가 같은 사람에게 보내려 할 때 그 자리에서 보여야 하기 때문이다.
 *
 * 주소를 지우지는 않는다 — 명함·서명에 적혀 있던 값이라 지우면 다음 사람이 같은 주소를
 * 다시 적어 넣는다. 대신 줄을 긋고 붉은 꼬리표를 달아 두고, 주소를 고쳐 적으면
 * (담당자 emails 에서 빠지면) 표시가 저절로 사라진다.
 */

/** 그 주소가 반송 목록에 들어 있는가(대소문자·앞뒤 공백 무시). */
export function isBounced(email: string, bad?: string[] | null): boolean {
  const key = (email || "").trim().toLowerCase();
  if (!key) return false;
  return (bad ?? []).some((b) => (b || "").trim().toLowerCase() === key);
}

/** 담당자 레코드에 반송된 주소가 하나라도 있는가(명부 줄에 꼬리표를 달지 판단). */
export function hasBounced(emails: string[] | undefined, bad?: string[] | null): boolean {
  return (emails ?? []).some((m) => isBounced(m, bad));
}

export function BounceBadge({ title }: { title?: string }) {
  return (
    <span
      className="bounce-badge"
      title={title || "This address bounced — Address not found."}
    >
      ⚠ Address not found
    </span>
  );
}

/** 주소 한 줄 — 반송이면 줄을 긋고 꼬리표를 단다. */
export function MailAddress({
  email,
  bounced,
  link = true,
}: {
  email: string;
  bounced: boolean;
  link?: boolean;
}) {
  return (
    <span className={`mail-addr${bounced ? " bounced" : ""}`}>
      {link ? <a href={`mailto:${email}`}>{email}</a> : <span>{email}</span>}
      {bounced ? <BounceBadge /> : null}
    </span>
  );
}
