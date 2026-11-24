// "드라이브에 저장할까요?" 창을 여는 자리 — 창은 AppShell 의 DriveSaveHost 하나가 그린다.
// 저장하면 편집 창이 닫히거나 다시 그려지므로, 묻는 창을 편집기 안에 두면 함께 사라진다.

import { fetchRfqDriveFolder } from "@/lib/api";

/** 만들어 올릴 문서 하나(견적서 PDF·Excel) — 저장을 누른 순간 get 으로 받아 온다. */
export type DriveSaveFile = { name: string; on: boolean; get: () => Promise<Blob> };

export type DriveSaveRequest = {
  rfqId: number;
  /** 서버가 하위 폴더 기본 이름을 정하는 열쇠 — qtn:ID(고객사명) · vq:ID(공급사명). */
  ref: string;
  title: string;
  files: DriveSaveFile[];
  /** 사람이 붙인 원본 파일(받은 견적서). allowAttach 면 창에서 더 고를 수 있다. */
  attach?: File[];
  allowAttach?: boolean;
  note?: string;
  onSaved?: () => void;
};

/** 열린 창 — n 은 열 때마다 달라져, 새 요청이면 창을 새로 그리게 한다. */
type OpenRequest = DriveSaveRequest & { n: number };

let current: OpenRequest | null = null;
let opened = 0;
const listeners = new Set<() => void>();
export const subscribeDriveSave = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const getDriveSave = () => current;

export function openDriveSave(req: DriveSaveRequest | null) {
  current = req ? { ...req, n: ++opened } : null;
  listeners.forEach((fn) => fn());
}

// "이 프로젝트에서는 다시 묻지 않기" — 새로고침하면 풀린다(잠깐 여러 번 고쳐 저장할 때용).
const muted = new Set<string>();
const muteKey = (req: DriveSaveRequest) => `${req.rfqId}:${req.ref.split(":")[0]}`;
export const muteDriveSave = (req: DriveSaveRequest) => { muted.add(muteKey(req)); };

/** 저장 직후 부른다 — 프로젝트 폴더가 연결된 딜에서만 묻는다. 기다리지 않고, 실패해도 조용하다
 *  (문서 저장은 이미 끝났다). */
export function promptDriveSave(req: DriveSaveRequest) {
  if (!req.rfqId || muted.has(muteKey(req))) return;
  fetchRfqDriveFolder(req.rfqId)
    .then((r) => { if (r.enabled && r.folder_url) openDriveSave(req); })
    .catch(() => {});
}
