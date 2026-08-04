"""회사 프로필(회사명·주소·계좌·서명) 저장소.

정본은 DB(app_settings 의 "company" 행)다. 예전에는 config/company.json 파일에 썼는데,
Render 처럼 배포마다 컨테이너를 새로 만드는 환경에서는 컨테이너 디스크에 쓴 값이 다음
배포·재시작 때 사라진다 — 설정 화면에서 저장한 계좌 정보가 그렇게 날아갔다.

파일은 이제 씨앗값으로만 쓴다: DB 에 행이 없으면 파일을 읽어 DB 로 옮기고, 그다음부터는
DB 만 본다. 문서(PDF·Excel) 렌더도 같은 함수를 거치므로 화면에 보이는 값과 인쇄되는
값이 어긋나지 않는다.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

from db.engine import get_session
from db.models import AppSetting

_KEY = "company"
_SEED_FILE = Path(__file__).resolve().parent.parent / "config" / "company.json"


def _seed_from_file() -> Dict[str, Any]:
    try:
        return json.loads(_SEED_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def read_company_profile() -> Dict[str, Any]:
    """저장된 회사 프로필. DB 에 없으면 파일 씨앗값을 DB 에 옮겨 심고 그 값을 준다."""
    s = get_session()
    try:
        row = s.query(AppSetting).filter_by(key=_KEY).first()
        if row and isinstance(row.value, dict) and row.value:
            return dict(row.value)
        seed = _seed_from_file()
        if seed:
            # 최초 1회 이행 — 다음부터는 DB 만 읽는다(파일이 없어도 값이 남는다).
            s.add(AppSetting(key=_KEY, value=seed, updated_at=datetime.utcnow()))
            s.commit()
        return seed
    except Exception:
        # DB 가 아직 준비되지 않은 상황(초기 부팅 등)에서도 문서 렌더는 막지 않는다.
        return _seed_from_file()
    finally:
        s.close()


def write_company_profile(data: Dict[str, Any]) -> None:
    s = get_session()
    try:
        row = s.query(AppSetting).filter_by(key=_KEY).first()
        if row:
            row.value = dict(data)
            row.updated_at = datetime.utcnow()
        else:
            s.add(AppSetting(key=_KEY, value=dict(data), updated_at=datetime.utcnow()))
        s.commit()
    finally:
        s.close()
