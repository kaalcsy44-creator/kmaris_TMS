"""환율 고시 조회 — 한국수출입은행 환율 Open API.

해당일 고시의 세 값을 날짜 기준으로 조회한다.
  · deal_bas_r — 매매기준율(계산에 쓰는 값)
  · tts        — 전신환 보내실 때(= 우리가 외화를 '살 때')
  · ttb        — 전신환 받으실 때(= 우리가 외화를 '팔 때')
주말·공휴일·오전 고시 전에는 데이터가 비므로 최대 7일 이전 영업일까지 거슬러 찾는다.

인증키는 환경변수 EXIM_API_KEY 로 주입한다(미설정 시 조회 불가 → None 반환,
호출측에서 고정환율로 폴백). 결과는 (날짜,통화) 단위로 프로세스 메모리에 캐시.

API: https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON
     ?authkey=KEY&searchdate=YYYYMMDD&data=AP01

주의: 예전 주소인 www.koreaexim.go.kr 의 같은 경로는 응답 없이 매달린다(읽기 타임아웃).
사이트(www)는 살아 있어서 DNS·TLS 는 정상으로 보이고 요청만 안 끝나므로, 증상이
"네트워크 실패"로만 보인다. 오픈 API 는 반드시 oapi 호스트로 호출한다.
"""
from __future__ import annotations

import json
import os
import ssl
import urllib.request
from datetime import datetime, timedelta

_API_URL = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON"
# (YYYYMMDD, 통화) → {"base": float, "tts": float|None, "ttb": float|None}
_CACHE: dict[tuple[str, str], dict] = {}


def _parse_rate(text: str) -> float | None:
    try:
        return float((text or "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None


# 조회 실패 사유 — 화면에 그대로 표시해 "무엇을 고쳐야 하는지"가 바로 드러나게 한다.
#   no_key     인증키 미설정(EXIM_API_KEY)
#   bad_key    인증키 거부(고시 응답 result=3)
#   quota      일일 호출 한도 초과(result=4)
#   data_code  DATA 코드 오류(result=2) — 코드 버그
#   network    요청 실패(타임아웃·SSL·DNS 등)
#   no_data    응답은 정상인데 그 날짜 고시가 없음(주말·공휴일·오전 고시 전)
def _fetch_day(date_yyyymmdd: str, cur: str) -> tuple[dict | None, str]:
    """단일 날짜의 고시 조회 → (값, 실패사유). 성공하면 사유는 "".

    JPY(100) 처럼 100 단위로 고시되는 통화는 cur_unit 에 단위가 붙는다 — 값은 그대로
    두고(고시 원문 그대로) 호출측이 통화 표기와 함께 쓴다."""
    key = os.getenv("EXIM_API_KEY", "").strip()
    if not key:
        return None, "no_key"
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
            return None, "network"
    else:
        return None, "network"
    if not isinstance(rows, list):
        return None, "network"
    # 고시가 없는 날은 빈 배열, 키·코드 문제는 result 코드로 돌아온다(값 없이).
    for row in rows:
        code = row.get("result")
        if code in (2, 3, 4):
            return None, {2: "data_code", 3: "bad_key", 4: "quota"}[code]
    want = (cur or "USD").upper()
    for row in rows:
        if str(row.get("cur_unit", "")).upper().startswith(want):
            base = _parse_rate(row.get("deal_bas_r"))
            if base is None:
                return None, "no_data"
            return {"base": base,
                    "tts": _parse_rate(row.get("tts")),
                    "ttb": _parse_rate(row.get("ttb"))}, ""
    return None, "no_data"


def get_rates(date_str: str, cur: str = "USD") -> tuple[dict | None, str, str]:
    """date_str(YYYY-MM-DD) 기준 고시({"base","tts","ttb"}) · 사용 날짜 · 실패사유.

    고시가 없으면 최대 7일 이전 영업일까지 거슬러 찾는다. 키·한도·네트워크 문제는
    날짜를 바꿔도 결과가 같으므로 첫 실패에서 바로 그 사유를 들고 나온다(불필요한
    8회 재시도 방지).
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
            return _CACHE[ck], d.isoformat(), ""
        row, err = _fetch_day(ymd, cur)
        if row is not None:
            _CACHE[ck] = row
            return row, d.isoformat(), ""
        if err != "no_data":
            return None, "", err
    return None, "", "no_data"


def get_deal_base_rate(date_str: str, cur: str = "USD") -> tuple[float | None, str]:
    """매매기준율만 필요한 호출부(대시보드 환산 등)를 위한 얇은 래퍼."""
    row, used, _err = get_rates(date_str, cur)
    return (row["base"] if row else None), used
