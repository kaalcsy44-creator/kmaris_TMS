"""기존 프로젝트(RFQ) ↔ 이미 있는 드라이브 폴더 짝짓기.

자동으로 확정하지 않는다. 1) 후보 목록(xlsx)을 뽑고 2) 사람이 '확정' 칸에 O 를 적거나
'직접 지정' 칸에 폴더 링크를 붙인 뒤 3) --apply 로 그 줄만 RFQ 에 적는다.
드라이브는 읽기만 하고(폴더를 만들거나 옮기거나 이름을 바꾸지 않는다), 이미 링크가 있는
RFQ 는 건드리지 않는다.

    # 1) 후보 목록 — DB·드라이브 모두 읽기만
    DATABASE_URL=... DRIVE_PARTS_ROOT_ID=... DRIVE_SERVICE_ROOT_ID=... \
        python scripts/match_drive_folders.py --out 후보.xlsx
    # 3) 사람이 표시한 줄만 적용(먼저 드라이런으로 보여 준다)
    python scripts/match_drive_folders.py --confirm 후보.xlsx            # 드라이런
    python scripts/match_drive_folders.py --confirm 후보.xlsx --apply    # 저장
"""
from __future__ import annotations

import argparse
import difflib
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

from db.engine import get_session  # noqa: E402
from db.models import RFQ, Customer, Vessel  # noqa: E402
from services import drive_svc as d  # noqa: E402
from services.project_drive import customer_label, work_type_key  # noqa: E402

FOLDER_RE = re.compile(r"^(\d{6})\s+(.*)$")
STOP = {"spare", "spares", "parts", "part", "the", "and", "for", "of", "etc", "na", "mv", "mt",
        "spare-parts", "various", "marine", "service", "services"}


def toks(s: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", (s or "").lower()) if t not in STOP and len(t) > 1]


def ymd(s: str) -> date | None:
    m = re.match(r"(\d{2})(\d{2})(\d{2})$", s or "")
    if m:
        try:
            return date(2000 + int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s or "")
    return date(int(m[1]), int(m[2]), int(m[3])) if m else None


def project_folders(root: str, tree: str) -> list[dict]:
    """루트 바로 아래와 월별 폴더(2606·2607…) 아래의 `yymmdd …` 폴더들."""
    out = []
    for f in d._children(root, folders_only=True):
        if re.fullmatch(r"\d{4}", f["name"]):
            for g in d._children(f["id"], folders_only=True):
                if FOLDER_RE.match(g["name"]):
                    out.append({**g, "where": f"{tree}/{f['name']}"})
        elif FOLDER_RE.match(f["name"]):
            out.append({**f, "where": tree})
    for f in out:
        m = FOLDER_RE.match(f["name"])
        f["date"] = ymd(m[1])
        f["toks"] = set(toks(m[2]))
        f["head"] = (toks(m[2]) or [""])[0]
    return out


def score(rfq: dict, f: dict) -> tuple[float, dict]:
    why = {}
    sc = 0.0
    if rfq["date"] and f["date"]:
        dd = abs((f["date"] - rfq["date"]).days)
        why["날짜차"] = dd
        sc += 3 if dd == 0 else 2 if dd <= 3 else 1 if dd <= 14 else 0
    # 고객사 — 약칭·회사명 첫 단어가 폴더 첫 단어와 같거나 비슷(오타 Angloeatern 등)
    cust_hit = any(a and (a in f["toks"] or difflib.SequenceMatcher(None, a, f["head"]).ratio() >= 0.8)
                   for a in rfq["cust_alias"])
    why["고객"] = cust_hit
    sc += 2 if cust_hit else 0
    vt = rfq["vessel_toks"]
    if vt:
        hit = len(vt & f["toks"]) / len(vt)
        why["선박"] = round(hit, 2)
        sc += 3 * hit
    tt = rfq["title_toks"]
    if tt:
        j = len(tt & f["toks"]) / len(tt | (f["toks"] - rfq["cust_alias"] - vt) or {"_"})
        why["제목"] = round(j, 2)
        sc += 4 * j
    return round(sc, 2), why


def build_candidates(out_path: Path) -> None:
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    s = get_session()
    try:
        trees = {}
        for wt, tree in (("PARTS", "PARTS"), ("SERVICE", "SERVICE")):
            root = d.root_id(wt)
            if not root:
                raise SystemExit(f"DRIVE_{wt}_ROOT_ID 가 없습니다.")
            trees[wt] = project_folders(root, tree)
            print(f"{tree}: 프로젝트 폴더 {len(trees[wt])}개")
        rows = []
        for r in s.query(RFQ).order_by(RFQ.id).all():
            cust = s.query(Customer).filter_by(id=r.customer_id).first() if r.customer_id else None
            ves = s.query(Vessel).filter_by(id=r.vessel_id).first() if r.vessel_id else None
            alias = {t for t in toks(customer_label(cust))[:1] + toks(cust.name if cust else "")[:1]}
            rows.append({
                "id": r.id, "rfq_no": r.rfq_no, "wt": work_type_key(r),
                "date": ymd((r.received_at or r.date or "")[:10]),
                "cust": customer_label(cust), "cust_alias": alias,
                "vessel": ves.name if ves else "", "vessel_toks": set(toks(ves.name if ves else "")),
                "title": r.project_title or "", "title_toks": set(toks(r.project_title or "")),
                "linked": r.drive_folder_id or "",
            })
    finally:
        s.close()

    # 점수 매기기 → 높은 점수부터 한 폴더 한 프로젝트로 배정
    pairs = []
    for r in rows:
        if r["linked"]:
            continue
        for f in trees[r["wt"]]:
            sc, why = score(r, f)
            if sc > 0:
                pairs.append((sc, r["id"], f["id"], why))
    pairs.sort(key=lambda p: -p[0])
    by_rfq: dict[int, list] = {}
    for sc, rid, fid, why in pairs:
        by_rfq.setdefault(rid, []).append((sc, fid, why))
    used: set[str] = set()
    best: dict[int, tuple] = {}
    for sc, rid, fid, why in pairs:
        if rid in best or fid in used:
            continue
        best[rid] = (sc, fid, why)
        used.add(fid)
    fmeta = {f["id"]: f for t in trees.values() for f in t}

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "후보"
    # 한 줄 = KTMS 딜 하나. 왼쪽에 딜, 바로 옆에 연결할 폴더를 두어 화면을 옮기지 않고
    # 둘을 견주게 한다. '참고: 다음 후보'는 비교용일 뿐 연결되지 않는다(맨 뒤로 뺐다).
    head = ["RFQ id", "KTMS 딜 (번호 · 수신일 · 고객 · 선박 · 제목)", "판정", "확정(O/X)",
            "연결할 폴더 (추천)", "근거", "직접 지정(폴더 링크)", "폴더 링크", "폴더 위치",
            "참고: 다음 후보 (연결 안 됨)"]
    ws.append(head)
    bold = Font(bold=True)
    for c in ws[1]:
        c.font = bold

    def why_text(w: dict) -> str:
        out = []
        if "날짜차" in w:
            out.append("날짜 같음" if w["날짜차"] == 0 else f"날짜 {w['날짜차']}일 차이")
        out.append("고객 일치" if w.get("고객") else "고객 다름")
        if "선박" in w:
            v = w["선박"]
            out.append("선박 일치" if v >= 0.99 else "선박 일부" if v > 0 else "선박 다름")
        if "제목" in w:
            out.append(f"제목 {round(w['제목'] * 100)}% 겹침")
        return " · ".join(out)
    fills = {"확실": "E2F0D9", "후보": "FFF2CC", "없음": "F8CBAD", "연결됨": "DDEBF7"}
    counts = {}
    for r in rows:
        if r["linked"]:
            verdict, sc, f1, why, f2 = "연결됨", "", None, {}, None
        elif r["id"] in best:
            sc, fid, why = best[r["id"]]
            f1 = fmeta[fid]
            alts = [x for x in by_rfq[r["id"]] if x[1] != fid]
            f2 = (fmeta[alts[0][1]], alts[0][0]) if alts else None
            margin = sc - (alts[0][0] if alts else 0)
            sure = why.get("고객") and why.get("날짜차", 99) <= 3 and (
                why.get("선박", 0) >= 0.99 or why.get("제목", 0) >= 0.3) and margin >= 1.5
            verdict = "확실" if sure else "후보" if sc >= 4 else "없음"
            if verdict == "없음":
                f1 = None
        else:
            verdict, sc, f1, why, f2 = "없음", "", None, {}, None
        counts[verdict] = counts.get(verdict, 0) + 1
        deal = " · ".join(x for x in (
            r["rfq_no"], r["date"].strftime("%y%m%d") if r["date"] else "", r["cust"],
            r["vessel"] or "(선박 없음)", r["title"] or "(제목 없음)") if x)
        ws.append([
            r["id"], deal, verdict, "O" if verdict == "확실" else "",
            f1["name"] if f1 else "", why_text(why) if f1 else "", "",
            d.folder_url(f1["id"]) if f1 else "", f1["where"] if f1 else "",
            (f2[0]["name"] if f2 else ""),
        ])
        ws.cell(ws.max_row, 3).fill = PatternFill("solid", fgColor=fills[verdict])

    ws2 = wb.create_sheet("짝 없는 폴더")
    ws2.append(["폴더", "위치", "링크"])
    for c in ws2[1]:
        c.font = bold
    for f in sorted((f for t in trees.values() for f in t if f["id"] not in used), key=lambda x: x["name"]):
        ws2.append([f["name"], f["where"], d.folder_url(f["id"])])
    for sheet, widths, freeze in ((ws, [7, 70, 7, 9, 62, 40, 30, 22, 13, 50], "C2"),
                                  (ws2, [60, 16, 50], "A2")):
        for i, w in enumerate(widths, 1):
            sheet.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w
        sheet.freeze_panes = freeze      # 딜 칸은 옆으로 넘겨도 보이게 고정
    wb.save(out_path)
    print("판정:", ", ".join(f"{k} {v}" for k, v in counts.items()))
    print(f"짝 없는 폴더: {ws2.max_row - 1}개")
    print(f"저장: {out_path}")


def apply_confirmed(path: Path, apply: bool) -> None:
    import openpyxl
    ws = openpyxl.load_workbook(path, read_only=True)["후보"]
    rows = list(ws.iter_rows(values_only=True))
    head = list(rows[0])
    i_id, i_link = head.index("RFQ id"), head.index("폴더 링크")
    i_ok, i_manual = head.index("확정(O/X)"), head.index("직접 지정(폴더 링크)")
    want: dict[int, str] = {}
    for row in rows[1:]:
        manual = str(row[i_manual] or "").strip()
        ok = str(row[i_ok] or "").strip().upper() == "O"
        src = manual or (row[i_link] if ok else "")
        m = re.search(r"folders/([A-Za-z0-9_-]+)", str(src or ""))
        if m:
            want[int(row[i_id])] = m[1]
    print(f"확정된 줄: {len(want)}건")
    s = get_session()
    try:
        seen: dict[str, int] = {}
        n = 0
        for rid, fid in sorted(want.items()):
            if fid in seen:
                print(f"  ✗ 같은 폴더를 두 프로젝트가 가리킴: RFQ {seen[fid]} · {rid} — 건너뜀")
                continue
            seen[fid] = rid
            r = s.query(RFQ).filter_by(id=rid).first()
            if r is None:
                print(f"  ✗ RFQ {rid} 없음")
                continue
            if r.drive_folder_id:
                print(f"  = RFQ {r.rfq_no} 는 이미 연결됨 — 건너뜀")
                continue
            meta = d.get_folder(fid)
            if meta is None:
                print(f"  ✗ RFQ {r.rfq_no}: 폴더 {fid} 를 열 수 없음 — 건너뜀")
                continue
            print(f"  → {r.rfq_no}: {meta['name']}")
            r.drive_folder_id, r.drive_folder_url = fid, d.folder_url(fid)
            n += 1
        if apply:
            s.commit()
            print(f"저장했습니다: {n}건")
        else:
            s.rollback()
            print(f"드라이런 — {n}건을 적용할 수 있습니다. 저장하려면 --apply")
    finally:
        s.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, help="후보 목록 xlsx 를 만들 경로")
    ap.add_argument("--confirm", type=Path, help="사람이 표시한 후보 목록 xlsx")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    if a.confirm:
        apply_confirmed(a.confirm, a.apply)
    elif a.out:
        build_candidates(a.out)
    else:
        ap.error("--out 또는 --confirm 을 주세요")
