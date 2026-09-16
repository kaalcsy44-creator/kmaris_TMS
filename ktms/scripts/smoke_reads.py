"""주요 조회 엔드포인트 연기 시험 — 화면을 열기 전에 쿼리를 한 번씩 돌려 본다.

  python scripts/smoke_reads.py <sqlite 파일 경로>      (운영 DB 를 가리키지 말 것)

왜 있는가: `import admin_api` 가 통과해도 화면은 터질 수 있다. 모델에서 컬럼을 떼면
그 컬럼을 참조하는 쿼리는 import 시점에 아무 말도 하지 않다가, 그 쿼리가 실제로 도는
순간에야 AttributeError 를 낸다. 실제로 APRecord.kind 를 떼면서 _deal_progress 의
필터를 남겨 두는 바람에 대시보드가 통째로 죽은 적이 있다.

읽기만 한다 — 목록 화면이 부르는 엔드포인트를 정적 토큰으로 한 번씩 GET 한다.
모델·쿼리를 손댔다면 커밋 전에 DB 사본에 대고 한 번 돌려 보는 것으로 충분하다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if len(sys.argv) < 2:
    sys.exit("usage: python scripts/smoke_reads.py <sqlite file>")
os.environ["DATABASE_URL"] = "sqlite:///" + sys.argv[1]

from fastapi.testclient import TestClient  # noqa: E402

import admin_api  # noqa: E402
from _core import app  # noqa: E402

# 인증은 우회하지 않고 정적 토큰으로 통과한다 — 권한 미들웨어까지 실제 경로로 지난다.
client = TestClient(app, headers={"Authorization": "Bearer dev-token"})

PATHS = [
    "/api/admin/dashboard",
    "/api/admin/pipeline",
    "/api/admin/ar-overview",
    "/api/admin/po-overview",
    "/api/admin/po-work-options",
    "/api/admin/documents-overview",
    "/api/admin/rfq-overview",
    "/api/admin/quotation-overview",
    "/api/admin/vendor-po-overview",
    "/api/admin/claims",
    "/api/admin/finance/summary",
]

bad = 0
for path in PATHS:
    try:
        r = client.get(path)
    except Exception as e:  # noqa: BLE001
        print(f"[EXC ] {path}\n       {type(e).__name__}: {e}")
        bad += 1
        continue
    if r.status_code >= 400:
        print(f"[{r.status_code}] {path}\n       {r.text[:300]}")
        bad += 1
    else:
        print(f"[OK  ] {path}")

print(f"\n{len(PATHS) - bad}/{len(PATHS)} ok")
sys.exit(1 if bad else 0)
