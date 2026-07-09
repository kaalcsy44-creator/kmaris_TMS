"""환율(매매기준율) 조회 — 한국수출입은행 환율 Open API.

'해당일의 매매기준율(deal_bas_r)' 을 날짜 기준으로 조회한다. 주말·공휴일·오전
고시 전에는 데이터가 비므로 최대 7일 이전 영업일까지 거슬러 찾는다.

인증키는 환경변수 EXIM_API_KEY 로 주입한다(미설정 시 조회 불가 → None 반환,
호출측에서 고정환율로 폴백). 결과는 (날짜,통화) 단위로 프로세스 메모리에 캐시.

API: https://www.koreaexim.go.kr/site/program/financial/exchangeJSON
     ?authkey=KEY&searchdate=YYYYMMDD&data=AP01
"""
from __future__ import annotations

import json
import os
import ssl
import urllib.request
from datetime import datetime, timedelta

_API_URL = "https://www.koreaexim.go.kr/site/program/financial/exchangeJSON"
_CACHE: dict[tuple[str, str], float] = {}


def _parse_rate(text: str) -> float | None:
    try:
        return float((text or "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _fetch_day(date_yyyymmdd: str, cur: str) -> float | None:
    """단일 날짜의 매매기준율 조회. 데이터 없으면 None."""
    key = os.getenv("EXIM_API_KEY", "").strip()
    if not key:
        return None
    url = f"{_API_URL}?authkey={key}&searchdate={date_yyyymmdd}&data=AP01"
    # koreaexim.go.kr 의 인증서 체인 문제로 검증 실패 시 1회 미검증 재시도(공공 API 한정).
    for ctx in (None, ssl._create_unverified_context()):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "KTMS/1.0"})
            with urllib.request.urlopen(req, timeout=8, context=ctx) as resp:
                rows = json.loads(resp.read().decode("utf-8") or "[]")
            break
        except ssl.SSLError:
            continue
        except Exception:
            return None
    else:
        return None
    if not isinstance(rows, list):
        return None
    want = (cur or "USD").upper()
    for row in rows:
        if str(row.get("cur_unit", "")).upper().startswith(want):
            return _parse_rate(row.get("deal_bas_r"))
    return None


def get_deal_base_rate(date_str: str, cur: str = "USD") -> tuple[float | None, str]:
    """date_str(YYYY-MM-DD) 기준 매매기준율과 실제 사용 날짜(YYYY-MM-DD)를 반환.

    데이터가 없으면 최대 7일 이전 영업일까지 거슬러 찾는다. 모두 실패하면 (None, "").
    """
    cur = (cur or "USD").upper()
    try:
        base = datetime.strptime((date_str or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        base = (datetime.utcnow() + timedelta(hours=9)).date()  # KST 오늘
    for back in range(0, 8):
        d = base - timedelta(days=back)
        ymd = d.strftime("%Y%m%d")
        ck = (ymd, cur)
        if ck in _CACHE:
            return _CACHE[ck], d.isoformat()
        rate = _fetch_day(ymd, cur)
        if rate is not None:
            _CACHE[ck] = rate
            return rate, d.isoformat()
    return None, ""
