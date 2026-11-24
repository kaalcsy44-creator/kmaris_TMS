"use client";

import { useEffect, useState } from "react";
import { fetchRfqDriveFolder } from "@/lib/api";
import { openDriveSave, type DriveSaveRequest } from "@/lib/driveSave";

/** 저장본을 지금 드라이브에 남기는 단추 — 고친 것 없이도(읽기 화면에서도) 누를 수 있다.
 *  프로젝트에 드라이브 폴더가 연결돼 있지 않으면 서지 않는다. */
export default function DriveSaveButton({ rfqId, build }: { rfqId?: number | null; build: () => DriveSaveRequest }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    setOn(false);
    if (rfqId) {
      fetchRfqDriveFolder(rfqId)
        .then((r) => { if (alive) setOn(r.enabled && !!r.folder_url); })
        .catch(() => {});
    }
    return () => { alive = false; };
  }, [rfqId]);
  if (!on) return null;
  return (
    <button type="button" className="btn" onClick={() => openDriveSave(build())}
            title="Save this quotation to the project's Google Drive folder (02 QTN)">
      📁 Drive
    </button>
  );
}
