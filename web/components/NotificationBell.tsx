"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchNotifications } from "@/lib/api";
import { getUser } from "@/lib/auth";
import type { NotificationItem } from "@/lib/types";

// 상단바 알림(종) — 팔로업이 필요한 딜(견적 보낸 뒤 무응답 등)과 D-3 이내·연체된
// 수금/지급 예정을 모아 보여준다. 알림은 서버가 조회 때마다 기존 데이터에서 세우므로
// 조치하면(노트·발송·입금 기록) 저절로 사라진다. 읽음 표시만 이 브라우저에 둔다.

const REFRESH_MS = 5 * 60 * 1000; // 화면이 보이는 동안 5분마다 갱신
const FRESH_MS = 2 * 60 * 1000;   // 화면 이동마다 머리줄이 다시 서도 2분 안이면 재조회 안 함

type Cache = { key: string; at: number; items: NotificationItem[] };
let cache: Cache | null = null;

type Filter = "all" | "deal" | "finance";

function storeKey(kind: string): string {
  return `ktms.notif.${kind}.${getUser()?.username ?? ""}`;
}
function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 저장 불가(시크릿 창 등) — 읽음 표시만 잊는다 */
  }
}

function fmtAmount(a: number | null, cur: string): string {
  if (a == null || !cur) return "";
  const krw = cur.toUpperCase() === "KRW";
  const n = a.toLocaleString("en-US", { maximumFractionDigits: krw ? 0 : 2 });
  return krw ? `₩${n}` : `${cur.toUpperCase()} ${n}`;
}

const TYPE_LABEL: Record<NotificationItem["type"], string> = {
  deal: "Project",
  receivable: "Receivable",
  payable: "Payable",
};

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<boolean>(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<NotificationItem[]>(() => cache?.items ?? []);
  const [read, setRead] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  // 저장된 설정(내 것만/전체)과 읽음 목록 — 마운트 후 읽는다(SSR 과 어긋나지 않게).
  useEffect(() => {
    setMine(loadJSON<boolean>(storeKey("mine"), true));
    setRead(new Set(loadJSON<string[]>(storeKey("read"), [])));
  }, []);

  const load = useCallback(
    (force = false) => {
      const key = mine ? "mine" : "all";
      if (!force && cache && cache.key === key && Date.now() - cache.at < FRESH_MS) {
        setItems(cache.items);
        return;
      }
      setBusy(true);
      fetchNotifications(mine)
        .then((d) => {
          cache = { key, at: Date.now(), items: d.items };
          setItems(d.items);
          setErr("");
          // 더 이상 서지 않는 알림의 읽음 표시는 버린다 — 목록이 끝없이 자라지 않게.
          setRead((prev) => {
            const live = new Set(d.items.map((i) => i.id));
            const next = new Set(Array.from(prev).filter((id) => live.has(id)));
            saveJSON(storeKey("read"), Array.from(next));
            return next;
          });
        })
        .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load"))
        .finally(() => setBusy(false));
    },
    [mine]
  );

  // 처음 + 주기 갱신. 탭이 숨어 있으면 쉰다(DB 를 괜히 깨우지 않는다).
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // 바깥 클릭·Esc 로 닫기.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = useMemo(() => items.filter((i) => !read.has(i.id)), [items, read]);
  const urgentUnread = unread.some((i) => i.level === "urgent");
  const shown = useMemo(
    () =>
      items.filter((i) =>
        filter === "all" ? true : filter === "deal" ? i.type === "deal" : i.type !== "deal"
      ),
    [items, filter]
  );
  const countDeal = items.filter((i) => i.type === "deal").length;
  const countFin = items.length - countDeal;

  function markRead(ids: string[]) {
    setRead((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      saveJSON(storeKey("read"), Array.from(next));
      return next;
    });
  }

  function go(n: NotificationItem) {
    markRead([n.id]);
    setOpen(false);
    router.push(n.href);
  }

  function toggleMine(v: boolean) {
    setMine(v);
    saveJSON(storeKey("mine"), v);
  }

  return (
    <div className="nbell" ref={boxRef}>
      <button
        type="button"
        className={`nbell-btn${open ? " on" : ""}`}
        aria-label={`Notifications${unread.length ? ` (${unread.length} unread)` : ""}`}
        aria-expanded={open}
        title="Notifications"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) load();
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"
          />
        </svg>
        {unread.length ? (
          <span className={`nbell-badge${urgentUnread ? " urgent" : ""}`}>
            {unread.length > 99 ? "99+" : unread.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="nbell-panel" role="dialog" aria-label="Notifications">
          <div className="nbell-head">
            <b>Notifications</b>
            <div className="nbell-scope" role="group" aria-label="Project scope">
              <button type="button" className={mine ? "on" : ""} onClick={() => toggleMine(true)}>
                My projects
              </button>
              <button type="button" className={!mine ? "on" : ""} onClick={() => toggleMine(false)}>
                All
              </button>
            </div>
          </div>
          <div className="nbell-tabs">
            <button type="button" className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
              All <span>{items.length}</span>
            </button>
            <button type="button" className={filter === "deal" ? "on" : ""} onClick={() => setFilter("deal")}>
              Projects <span>{countDeal}</span>
            </button>
            <button
              type="button"
              className={filter === "finance" ? "on" : ""}
              onClick={() => setFilter("finance")}
            >
              Finance <span>{countFin}</span>
            </button>
            <button
              type="button"
              className="nbell-markall"
              disabled={!unread.length}
              onClick={() => markRead(items.map((i) => i.id))}
            >
              Mark all read
            </button>
          </div>

          <div className="nbell-list">
            {err ? (
              <div className="nbell-empty">Couldn’t load notifications — {err}</div>
            ) : busy && !items.length ? (
              <div className="nbell-empty">Loading…</div>
            ) : !shown.length ? (
              <div className="nbell-empty">Nothing needs your attention. 🎉</div>
            ) : (
              shown.map((n) => {
                const isRead = read.has(n.id);
                const amt = fmtAmount(n.amount, n.currency);
                return (
                  <button
                    key={n.id}
                    type="button"
                    className={`nbell-item lv-${n.level}${isRead ? " read" : ""}`}
                    onClick={() => go(n)}
                  >
                    <span className="nbell-dot" aria-hidden="true" />
                    <span className="nbell-body">
                      <span className="nbell-top">
                        <span className="nbell-type">{TYPE_LABEL[n.type]}</span>
                        {n.project_no ? <span className="nbell-proj">{n.project_no}</span> : null}
                        {n.date ? <span className="nbell-date">{n.date}</span> : null}
                      </span>
                      <span className="nbell-title">{n.title}</span>
                      <span className="nbell-detail">
                        <span className="nbell-detail-txt">
                          {[n.customer, n.detail].filter(Boolean).join(" · ")}
                        </span>
                        {amt ? <b className="nbell-amt">{amt}</b> : null}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="nbell-foot">
            Quote follow-up after 7 days · vendor quote after 5 · payments from D-3
          </div>
        </div>
      ) : null}
    </div>
  );
}
