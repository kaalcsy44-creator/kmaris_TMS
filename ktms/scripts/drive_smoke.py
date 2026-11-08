"""drive_svc 점검 — 이름 규칙(오프라인) + 공유 드라이브 실제 호출(라이브).

라이브 점검은 공유 드라이브 맨 위의 `_KTMS_TEST` 폴더 안에서만 만들고 올린다.
프로젝트 폴더(00 ★PROJECT_*)는 건드리지 않고, 아무것도 지우지 않는다.

    python scripts/drive_smoke.py              # 오프라인만
    python scripts/drive_smoke.py --live       # 라이브까지 (키 필요)
    python scripts/drive_smoke.py --live --drive-id 0APeWW0f3y_NXUk9PVA
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

from services import drive_svc as d  # noqa: E402

_fail = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global _fail
    print(("  ✓ " if ok else "  ✗ ") + label + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        _fail += 1


def offline() -> None:
    print("[오프라인] 이름 규칙")
    check("금지문자 제거", d.sanitize_name('GRAB NO. 4 | ULSAN / 24:NOV "26"') == "GRAB NO. 4 ULSAN 24 NOV 26")
    check("120자 자르기", len(d.sanitize_name("A" * 300)) == 120)
    check("프로젝트명 기본형",
          d.project_folder_name("2026-11-07", "Everhonest", "MSC VERACRUZ", "AE CW Pump Spares")
          == "261107 Everhonest MSC VERACRUZ AE CW Pump Spares")
    check("빈 칸은 NA",
          d.project_folder_name("2026-11-04", "MSACHKL", None, "") == "261104 MSACHKL NA NA")
    check("번호 붙이기", d._numbered("KMS-QUO-2611-003.pdf", 2) == "KMS-QUO-2611-003 (2).pdf")
    check("확장자 없는 이름", d._numbered("00 접수내용", 3) == "00 접수내용 (3)")
    check("점이 든 문서번호", d._split_ext("EHZM-26-0059.PI.pdf") == ("EHZM-26-0059.PI", ".pdf"))
    os.environ["DRIVE_PARTS_ROOT_ID"], os.environ["DRIVE_SERVICE_ROOT_ID"] = "P", "S"
    check("루트: PARTS", d.root_id("PARTS") == "P")
    check("루트: SERVICE", d.root_id("SERVICE") == "S")
    check("루트: 비면 PARTS", d.root_id(None) == "P")


def live(drive_id: str) -> None:
    print("[라이브] 공유 드라이브 `_KTMS_TEST` 안에서")
    sandbox = d.ensure_folder(drive_id, "_KTMS_TEST")
    check("샌드박스 폴더 멱등", d.ensure_folder(drive_id, "_KTMS_TEST") == sandbox)
    os.environ["DRIVE_PARTS_ROOT_ID"] = sandbox
    os.environ["DRIVE_SERVICE_ROOT_ID"] = sandbox

    stamp = time.strftime("%H%M%S")
    name = d.project_folder_name("2026-11-08", "Everhonest", "TEST VESSEL", f"Smoke {stamp}")
    p1 = d.ensure_project(name, work_type="PARTS")
    p2 = d.ensure_project(name, work_type="PARTS")
    check("프로젝트 폴더 두 번 → 하나", p1["folder_id"] == p2["folder_id"])
    check("하위 폴더 두 번 → 그대로", p1["sub"] == p2["sub"])
    names = sorted(f["name"] for f in d._children(p1["folder_id"], folders_only=True))
    check("하위 폴더 4개 표준 이름", names == ["01 RFQ", "02 QTN", "03 PO", "04 INV"], str(names))
    check("링크 형식", p1["folder_url"].endswith(p1["folder_id"]))

    # 저장된 ID 가 살아 있으면 이름이 달라도 그 폴더를 쓴다.
    p3 = d.ensure_project("다른 이름이어도", folder_id=p1["folder_id"])
    check("저장된 folder_id 우선", p3["folder_id"] == p1["folder_id"])
    p4 = d.ensure_project(name, folder_id="1NOT_A_REAL_FOLDER_ID_xxxxxxxxxx")
    check("죽은 folder_id 면 이름으로 다시 찾음", p4["folder_id"] == p1["folder_id"])

    # 옛 관행 폴더(RFQ, 03 PO PI)는 이름을 바꾸지 않고 그 자리로 쓴다.
    old = d.ensure_folder(sandbox, f"OLD STYLE {stamp}")
    rfq_old = d.ensure_folder(old, "RFQ")
    popi = d.ensure_folder(old, "03 PO PI")
    sub = d.ensure_subfolders(old)
    check("옛 RFQ 폴더 재사용", sub["RFQ"] == rfq_old)
    check("옛 03 PO PI 폴더 재사용", sub["PO"] == popi)
    old_names = sorted(f["name"] for f in d._children(old, folders_only=True))
    check("없는 것만 표준 이름으로 추가", old_names == ["02 QTN", "03 PO PI", "04 INV", "RFQ"], str(old_names))

    qtn = p1["sub"]["QTN"]
    pdf = b"%PDF-1.4\n% KTMS drive smoke " + stamp.encode() + b"\n%%EOF\n"
    a = d.upload_file(qtn, "KMS-QUO-2611-003.pdf", pdf, "application/pdf")
    b = d.upload_file(qtn, "KMS-QUO-2611-003.pdf", pdf + b" ", "application/pdf")
    check("첫 업로드 원래 이름", a["name"] == "KMS-QUO-2611-003.pdf", a["name"])
    check("같은 이름 → (2), 덮어쓰지 않음", b["name"] == "KMS-QUO-2611-003 (2).pdf", b["name"])
    c = d.upload_file(qtn, "KMS-QUO-2611-003.pdf", pdf, "application/pdf", skip_if_same=True)
    check("내용 같으면 건너뜀", c["skipped"] and c["id"] == a["id"], str(c))
    e = d.upload_file(qtn, "KMS-QUO-2611-003.pdf", pdf + b"  ", "application/pdf", skip_if_same=True)
    check("내용 다르면 (3)", (not e["skipped"]) and e["name"] == "KMS-QUO-2611-003 (3).pdf", e["name"])
    files = sorted(f["name"] for f in d._children(qtn))
    check("QTN 에 파일 3개", len(files) == 3, str(files))

    rfq = p1["sub"]["RFQ"]
    t = d.upload_text(rfq, "00 접수내용.md", "# 접수\nWhatsApp 대화 붙여넣기 시험\n")
    check("글 파일 올리기", t["name"] == "00 접수내용.md", t["name"])
    z = d.upload_file(rfq, "empty.txt", b"", "text/plain")
    check("빈 파일 올리기", bool(z["id"]))
    big = os.urandom(9 * 1024 * 1024)       # 조각(8MB)보다 큰 파일
    g = d.upload_file(rfq, "big_9MB.bin", big)
    meta = d._call("GET", f"{d.API}/files/{g['id']}", params={"fields": "size,md5Checksum"}).json()
    import hashlib
    check("9MB 조각 업로드 크기·내용 일치",
          int(meta["size"]) == len(big) and meta["md5Checksum"] == hashlib.md5(big).hexdigest(), str(meta))

    check("try_call: 실패를 삼키고 None",
          d.try_call(d.upload_file, "1NOT_A_REAL_FOLDER_ID_xxxxxxxxxx", "x.txt", b"x") is None)
    print(f"  → 시험 폴더: {p1['folder_url']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--drive-id", default="0APeWW0f3y_NXUk9PVA", help="공유 드라이브 ID")
    args = ap.parse_args()
    offline()
    if args.live:
        os.environ.pop("DRIVE_PARTS_ROOT_ID", None)
        live(args.drive_id)
    print("\n결과:", "모두 통과" if _fail == 0 else f"{_fail}건 실패")
    sys.exit(1 if _fail else 0)
