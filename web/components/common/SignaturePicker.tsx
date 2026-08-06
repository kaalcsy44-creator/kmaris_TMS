"use client";

import { useEffect, useRef, useState } from "react";
import { fetchEmailSignatures, type SignatureOwner } from "@/lib/api";

// 발송 화면의 "누구 이름으로 서명할지" 선택기.
//
// 서명은 담당자별로 저장된다(Settings → Email Templates → Signature). 한 사람이 팀의
// 메일을 대신 보내는 일이 잦아서, 발송 화면에서 다른 담당자의 서명을 불러와 그대로
// 실을 수 있어야 한다. 목록에는 개인 서명을 저장해 둔 담당자 전원과 로그인 사용자가 온다.
//
// 고르면 그 사람의 평문 서명을 서명칸에 넣는다. 발송할 때 서버가 같은 글자의 저장된
// 서명을 찾아 표(HTML) 서명으로 바꿔 보내므로, 남의 서명도 디자인 그대로 나간다.
export default function SignaturePicker({
  lang = "en",
  value,
  onPick,
  disabled = false,
}: {
  lang?: "en" | "ko";
  value: number | null;          // 지금 고른 담당자(id) — 없으면 로그인 사용자
  onPick: (userId: number, signature: string) => void;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<SignatureOwner[] | null>(null);
  const [me, setMe] = useState<number | null>(null);
  // 언어 전환 때 "고른 담당자의 그 언어 서명"으로 갈아 끼우기 위한 참조들.
  // (콜백·선택값을 effect 의존성에 넣으면 고를 때마다 목록을 다시 받는다.)
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const valueRef = useRef(value);
  valueRef.current = value;
  const langRef = useRef(lang);

  useEffect(() => {
    let alive = true;
    fetchEmailSignatures(lang)
      .then((d) => {
        if (!alive) return;
        setRows(d.rows);
        setMe(d.me);
        if (langRef.current !== lang) {
          langRef.current = lang;
          const row = d.rows.find((r) => r.user_id === valueRef.current);
          if (row) onPickRef.current(row.user_id, row.signature);
        }
      })
      .catch(() => {
        /* 목록을 못 받아도 서명칸은 서버 기본값 그대로 쓸 수 있다 — 선택기만 숨긴다. */
      });
    return () => {
      alive = false;
    };
  }, [lang]);

  // 고를 사람이 자기 자신뿐이면 선택기를 보여줄 이유가 없다.
  if (!rows || rows.length < 2) return null;

  return (
    <select
      className="sig-owner-pick"
      value={value ?? me ?? ""}
      disabled={disabled}
      title="이 담당자의 서명을 불러옵니다"
      onChange={(e) => {
        const id = Number(e.target.value);
        const row = rows.find((r) => r.user_id === id);
        if (row) onPick(row.user_id, row.signature);
      }}
    >
      {rows.map((r) => (
        <option key={r.user_id} value={r.user_id}>
          {r.name}
          {r.user_id === me ? " (me)" : ""}
          {r.is_default ? " · default" : ""}
        </option>
      ))}
    </select>
  );
}
