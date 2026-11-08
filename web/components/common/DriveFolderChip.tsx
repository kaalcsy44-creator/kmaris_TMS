"use client";

// 프로젝트 ↔ 공유 드라이브 폴더. 연결돼 있으면 "Folder" 로 바로 열고, 없으면
// "Create folder" 로 만든다(등록 직후 백그라운드 생성이 실패했을 때의 재시도 자리).
// 서버에 드라이브 연동이 설정돼 있지 않으면 아무것도 그리지 않는다.

import { useEffect, useState } from "react";
import { createRfqDriveFolder, fetchRfqDriveFolder, type RfqDriveFolder } from "@/lib/api";

export default function DriveFolderChip({ rfqId, className = "" }: { rfqId: number; className?: string }) {
  const [st, setSt] = useState<RfqDriveFolder | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setSt(null);
    setErr("");
    fetchRfqDriveFolder(rfqId)
      .then((r) => { if (alive) setSt(r); })
      .catch(() => { if (alive) setSt(null); });
    // 등록 직후에는 폴더를 백그라운드로 만드는 중일 수 있다 — 잠시 뒤 한 번 더 본다.
    const t = window.setTimeout(() => {
      fetchRfqDriveFolder(rfqId).then((r) => { if (alive) setSt(r); }).catch(() => {});
    }, 6000);
    return () => { alive = false; window.clearTimeout(t); };
  }, [rfqId]);

  if (!st || !st.enabled) return null;

  if (st.folder_url) {
    return (
      <a
        className={`drive-chip ${className}`}
        href={st.folder_url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open this project's Google Drive folder"
      >
        📁 Folder
      </a>
    );
  }

  async function create() {
    setBusy(true);
    setErr("");
    try {
      setSt(await createRfqDriveFolder(rfqId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the folder.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`drive-chip create ${className}`}
      onClick={create}
      disabled={busy}
      title={err || "This project has no Google Drive folder yet — create it now"}
    >
      {busy ? "📁 Creating…" : err ? "📁 Retry folder" : "📁 Create folder"}
    </button>
  );
}
