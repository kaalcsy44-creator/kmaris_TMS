"""매일 한 번, 사람 손 없이 도는 메일 정리.

지금까지 메일은 누군가 딜에 들어가 Sync 를 눌러야만 들어왔다. 그러면 아침에 여는
대시보드가 늘 어제 누가 눌렀는지에 달려 있게 된다. 백엔드(Render Starter)는 재우지
않고 상시 가동이므로, 앱 안에 얇은 스레드 하나를 두고 매일 정해진 시각에 돌린다.
따로 크론 서비스를 붙이거나 외부에서 토큰을 들고 때리게 하지 않는다.

도는 순서는 사람이 손으로 하던 것과 같다.
  1) 메일함 읽기(sync_mailbox)
  2) 근거가 분명한 것 자동 배정(auto_match)
  3) 새 메일 요약 채우기(ensure_summaries)
  4) 대시보드 카드의 AI 요약 채우기(build_project_rollup — 딜 하나당 호출 1회)

**"몇 시에 잠들었다 깨는" 방식이 아니라, 자주 깨어 "오늘 몫을 아직 안 했나"를 보는
방식이다.** 서버가 새벽에 재시작되면 잠들어 있던 타이머는 그대로 사라지지만, 이
방식은 다음 확인 때 "오늘 아직 안 돌았다"를 보고 밀린 몫을 그때 돌린다. 하루를
통째로 건너뛰는 일이 없고, 재시작이 잦아도 하루 한 번이 지켜진다(마지막 실행 날짜를
DB 에 남겨 판단하므로 인스턴스가 둘로 늘어도 두 번 돌지 않는다).

환경변수
  MAIL_AUTO_SYNC(1)      0 이면 자동 실행을 끈다(수동 Sync 버튼은 그대로 동작).
  MAIL_SYNC_AT(06:00)    KST 기준 실행 시각. 이 시각을 지나면 그날 몫을 돌린다.
  MAIL_AUTO_DIGESTS(10)  한 번에 만들 대시보드 요약 수(딜당 AI 호출 1회).
  MAIL_AUTO_CHECK_MIN(10) 몇 분마다 "오늘 몫을 했나" 확인할지.
"""
from __future__ import annotations

import os
import sys
import threading
from datetime import datetime

from db.models import AppSetting, EmailMessage
from services import mail_sync
from services.mail_summary import ROLLUP_KEY, build_project_rollup, ensure_summaries

STATE_KEY = "mail_auto_sync"      # {last_run_date, last_run_at, result, error}
# 한 번의 자동 실행에서 요약을 채울 메일 수 상한(딜에 붙은 것 우선).
_SUMMARY_LIMIT = 60

_thread: threading.Thread | None = None


# ── 설정 ──────────────────────────────────────────────────────────────────────

def config() -> dict:
    at = (os.getenv("MAIL_SYNC_AT", "06:00") or "06:00").strip()
    if not _valid_hhmm(at):
        at = "06:00"
    return {
        "enabled": (os.getenv("MAIL_AUTO_SYNC", "1") or "1").strip() not in ("0", "false", "no"),
        "at": at,
        "digests": max(0, int(os.getenv("MAIL_AUTO_DIGESTS", "10") or 10)),
        "check_min": max(1, int(os.getenv("MAIL_AUTO_CHECK_MIN", "10") or 10)),
    }


def _valid_hhmm(v: str) -> bool:
    try:
        h, m = v.split(":")
        return 0 <= int(h) <= 23 and 0 <= int(m) <= 59
    except (ValueError, AttributeError):
        return False


# ── 상태(마지막 실행) ─────────────────────────────────────────────────────────

def state(s) -> dict:
    row = s.query(AppSetting).filter_by(key=STATE_KEY).first()
    return (row.value or {}) if row else {}


def _save_state(s, value: dict) -> None:
    row = s.query(AppSetting).filter_by(key=STATE_KEY).first()
    if row:
        row.value, row.updated_at = value, datetime.utcnow()
    else:
        s.add(AppSetting(key=STATE_KEY, value=value, updated_at=datetime.utcnow()))
    s.commit()


def due(s, now: datetime | None = None) -> bool:
    """지금 오늘 몫을 돌려야 하는가 — 실행 시각을 지났고 오늘 아직 안 돌았으면."""
    cfg = config()
    if not cfg["enabled"] or not mail_sync.is_configured():
        return False
    now = now or datetime.now(mail_sync.KST)
    if now.strftime("%H:%M") < cfg["at"]:
        return False
    return state(s).get("last_run_date") != now.strftime("%Y-%m-%d")


def next_run_at(s, now: datetime | None = None) -> str:
    """다음 실행 예정 'YYYY-MM-DD HH:MM' (KST). 꺼져 있으면 빈 문자열."""
    cfg = config()
    if not cfg["enabled"]:
        return ""
    now = now or datetime.now(mail_sync.KST)
    today = now.strftime("%Y-%m-%d")
    ran_today = state(s).get("last_run_date") == today
    if not ran_today and now.strftime("%H:%M") >= cfg["at"]:
        return f"{today} {cfg['at']} (due now)"
    day = today if (not ran_today and now.strftime("%H:%M") < cfg["at"]) else _tomorrow(now)
    return f"{day} {cfg['at']}"


def _tomorrow(now: datetime) -> str:
    from datetime import timedelta
    return (now + timedelta(days=1)).strftime("%Y-%m-%d")


# ── 한 번 돌기 ────────────────────────────────────────────────────────────────

def run_once(s) -> dict:
    """오늘 몫을 돌린다 — 읽기 → 배정 → 통별 요약 → 카드 요약. 결과를 DB 에 남긴다.

    어느 단계에서 넘어져도 거기까지 한 일은 지키고 사유를 남긴다. 메일은 들어왔는데
    요약을 못 만든 것과, 메일함을 아예 못 읽은 것은 화면에서 구분돼야 한다."""
    now = datetime.now(mail_sync.KST)
    out: dict = {"at": now.strftime("%Y-%m-%d %H:%M"), "error": ""}
    try:
        out.update(mail_sync.sync_mailbox(s))
    except Exception as exc:
        out["error"] = f"sync: {exc}"[:300]
        _finish(s, now, out)
        return out

    try:
        out["auto_matched"] = mail_sync.auto_match(s)["total"]
    except Exception as exc:
        out["error"] = f"auto-match: {exc}"[:300]

    # 새 메일의 통별 요약 — 딜에 붙은 것부터. 카드 요약의 재료라 먼저 채운다.
    try:
        fresh = (s.query(EmailMessage)
                 .filter(EmailMessage.summary.is_(None), EmailMessage.rfq_id.isnot(None))
                 .order_by(EmailMessage.id.desc()).limit(_SUMMARY_LIMIT).all())
        out["summarized"] = ensure_summaries(s, fresh, limit=_SUMMARY_LIMIT)
    except Exception as exc:
        out["error"] = (out["error"] or "") + f" summaries: {exc}"[:200]

    try:
        out["digests"] = _write_digests(s, config()["digests"])
    except Exception as exc:
        out["error"] = (out["error"] or "") + f" digests: {exc}"[:200]

    _finish(s, now, out)
    return out


def _finish(s, now: datetime, out: dict) -> None:
    """오늘 돌았다는 사실을 남긴다 — 실패해도 남긴다.

    실패한 날을 '안 돈 날'로 두면 10분마다 같은 실패를 되풀이한다(메일 서버가
    막혀 있으면 하루 종일). 하루 한 번이라는 약속을 지키고, 무엇이 어긋났는지는
    error 로 화면에 보여 준다."""
    try:
        _save_state(s, {
            "last_run_date": now.strftime("%Y-%m-%d"),
            "last_run_at": now.strftime("%Y-%m-%d %H:%M"),
            "result": {k: v for k, v in out.items() if k != "folders"},
        })
    except Exception as exc:
        s.rollback()
        print(f"[WARN] mail auto-sync state not saved: {exc}", file=sys.stderr)


def _write_digests(s, limit: int) -> int:
    """대시보드 카드의 AI 요약을 채운다 — 없거나 낡은 딜만, 최근 것부터 limit 건.

    기간으로 좁히지 않는다(days=None) — 화면에 오르는 딜과 대상이 달라지면, 메일은
    오래됐지만 단계는 이번 주에 움직인 딜의 요약이 영영 비어 있게 된다."""
    if limit <= 0:
        return 0
    live = mail_sync.live_deals(s, days=None)
    if not live:
        return 0
    keys = {f"{ROLLUP_KEY}:{rid}": rid for rid in live}
    cached = {keys[r.key]: (r.value or {})
              for r in s.query(AppSetting.key, AppSetting.value)
              .filter(AppSetting.key.in_(list(keys))).all() if r.key in keys}
    todo = [rid for rid, (_, _, last_id) in live.items()
            if (cached.get(rid) or {}).get("last_id") != last_id]
    todo.sort(key=lambda rid: live[rid][1], reverse=True)
    picked = todo[:limit]
    nos = mail_sync._project_no_map(s) if picked else {}
    for rid in picked:
        build_project_rollup(s, rid, nos.get(rid, ""))
    return len(picked)


# ── 스레드 ────────────────────────────────────────────────────────────────────

def _loop() -> None:
    from _core import get_session

    cfg = config()
    while True:
        try:
            s = get_session()
            try:
                if due(s):
                    run_once(s)
            finally:
                s.close()
        except Exception as exc:      # 어떤 이유로도 이 스레드는 죽지 않는다
            print(f"[WARN] mail auto-sync tick failed: {exc}", file=sys.stderr)
        # 설정은 매번 다시 읽는다 — 재배포 없이 환경변수만 바꿔도 다음 주기에 반영된다.
        try:
            cfg = config()
        except Exception:
            pass
        threading.Event().wait(cfg["check_min"] * 60)


def start() -> None:
    """앱 기동 시 한 번 부른다. 꺼져 있거나 이미 떠 있으면 아무것도 하지 않는다."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    if not config()["enabled"]:
        return
    _thread = threading.Thread(target=_loop, name="mail-auto-sync", daemon=True)
    _thread.start()
