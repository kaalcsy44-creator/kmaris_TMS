"""거래선 명부(Customer · Vendor · Maker) 엑셀 업로드 — 읽고, 무엇이 바뀌는지 먼저 보여준다.

이 모듈은 파일을 저장하지 않는다. 파일에서 표를 꺼내고(read_sheet), 열이 무슨 뜻인지
짐작하고(auto_map), 그 표를 지금 명부에 겹쳐 보면 무슨 일이 생기는지 계산할(plan) 뿐이다.
저장은 그 계산 결과를 사람이 눈으로 보고 고른 뒤에야 일어난다.

병합 규칙은 이 화면의 명함 스캔과 같다 — **비어 있는 칸만 채우고, 이메일·전화처럼
여러 개를 갖는 칸은 없는 값만 보탠다.** 한 화면에서 규칙이 둘이면 사용자가 결과를
예측할 수 없다. 덮어쓰기는 따로 켜야 하는 선택지로 두고, 지우는 일은 하지 않는다 —
엑셀에 없는 줄은 "지우라"는 뜻이 아니라 그냥 그 파일에 없는 것이다.
"""
from __future__ import annotations

import csv
import io
import re
from typing import Any, Dict, List, Optional, Tuple

MAX_ROWS = 2000
MAX_COLS = 60
HEADER_SCAN_ROWS = 30

# ── 명부 갈래별 칸 ────────────────────────────────────────────────────────────
# (키, 화면 이름, 여러 값인가, 회사 단위 값인가)
#
# '회사 단위'는 같은 회사의 담당자들이 나눠 갖는 값이다(사업자번호·홈페이지·회사 소개).
# 새 담당자를 넣을 때 엑셀이 그 칸을 비워 두었으면 같은 회사의 기존 줄에서 물려받는다 —
# 화면에서 담당자를 더할 때 이미 그렇게 하고 있어서(withCompanyDefaults), 업로드만
# 다르게 굴면 같은 일을 두 경로로 했을 때 결과가 갈린다.
Field = Tuple[str, str, bool, bool]

FIELDS: Dict[str, List[Field]] = {
    "customers": [
        ("name", "Company", False, False),
        ("contact", "Contact", False, False),
        ("emails", "Email", True, False),
        ("phones", "Phone", True, False),
        ("regions", "Region", True, False),
        ("addresses", "Address", True, True),
        ("tax_id", "Tax ID", False, True),
        ("tax_invoice_email", "Tax invoice email", False, True),
        ("website", "Website", False, True),
        ("payment_terms", "Payment terms", False, True),
        ("specialization", "Specialization", False, True),
        ("note", "About this company", False, True),
    ],
    "vendors": [
        ("name", "Company", False, False),
        ("contact", "Contact", False, False),
        ("emails", "Email", True, False),
        ("phones", "Phone", True, False),
        ("regions", "Region", True, False),
        ("addresses", "Address", True, True),
        ("website", "Website", False, True),
        ("payment_terms", "Payment terms", False, True),
        ("specialization", "Specialization", False, True),
        ("note", "About this company", False, True),
    ],
    # 메이커는 담당자를 두지 않는다 — 회사 한 곳이 한 줄이라 '회사 단위'라는 구분도 없다.
    "makers": [
        ("name", "Maker", False, False),
        ("emails", "Email", True, False),
        ("phones", "Phone", True, False),
        ("regions", "Region", True, False),
        ("addresses", "Address", True, False),
        ("website", "Website", False, False),
        ("specialization", "Makes", False, False),
        ("note", "About this maker", False, False),
    ],
}

TITLE = {"customers": "Customer", "vendors": "Vendor", "makers": "Maker"}


def field_specs(kind: str) -> List[Dict[str, Any]]:
    return [{"key": k, "label": lb, "multi": m} for k, lb, m, _ in FIELDS[kind]]


# ── 열 이름 알아보기 ──────────────────────────────────────────────────────────
# 순서가 규칙이다. 앞의 칸이 먼저 가져간다 — "Tax invoice email" 은 이메일이 아니라
# 세금계산서 메일이고, "Contact name" 은 이름이 아니라 담당자다. 좁은 뜻을 위에 둔다.
#
# exact = 열 이름이 통째로 같을 때만, contains = 이름 안에 들어 있기만 해도.
# 둘을 가른 이유: "Mail" 은 이메일이지만 "Mailing address" 는 주소다.
_HEADERS: List[Tuple[str, List[str], List[str]]] = [
    ("tax_invoice_email",
     ["tax invoice email", "tax mail", "세금계산서 이메일", "세금계산서메일", "계산서메일"],
     ["tax invoice email", "세금계산서 이메일", "세금계산서메일"]),
    ("tax_id",
     ["tax id", "taxid", "business no", "business number", "brn", "사업자번호", "사업자등록번호", "사업자"],
     ["tax id", "business registration", "business no", "사업자등록", "사업자번호"]),
    ("contact",
     ["contact", "contact name", "contact person", "person in charge", "pic", "p i c",
      "attn", "attention", "rep", "담당자", "담당", "담당자명", "성명", "이름", "책임자"],
     ["contact name", "contact person", "person in charge", "담당자", "담당자명"]),
    ("emails",
     ["email", "e mail", "mail", "email address", "e mail address", "이메일", "메일", "이메일주소"],
     ["email", "e mail", "이메일", "메일주소"]),
    ("phones",
     ["phone", "tel", "telephone", "mobile", "cell", "hp", "fax", "contact no",
      "contact number", "phone no", "tel no", "전화", "전화번호", "연락처", "휴대폰", "핸드폰", "팩스"],
     ["phone", "tel no", "telephone", "mobile", "contact no", "contact number",
      "전화", "연락처", "휴대폰", "핸드폰"]),
    ("regions",
     ["region", "country", "nation", "location", "area", "city", "지역", "국가", "나라", "소재지", "도시"],
     ["region", "country", "지역", "국가", "소재지"]),
    ("addresses",
     ["address", "addresses", "office", "주소", "본사주소", "소재지주소"],
     ["address", "주소"]),
    ("website",
     ["website", "web site", "web", "homepage", "home page", "url", "site",
      "홈페이지", "웹사이트", "웹"],
     ["website", "web site", "homepage", "홈페이지", "웹사이트"]),
    ("payment_terms",
     ["payment terms", "payment term", "payment", "terms", "결제조건", "지불조건", "결제"],
     ["payment term", "결제조건", "지불조건"]),
    ("specialization",
     ["specialization", "speciality", "specialty", "makes", "supplies", "products",
      "items", "scope", "취급품목", "취급", "전문분야", "품목", "생산품목", "주력"],
     ["specialization", "취급품목", "전문분야", "생산품목"]),
    ("note",
     ["note", "notes", "about", "remark", "remarks", "description", "memo", "comment",
      "메모", "비고", "설명", "소개", "회사소개"],
     ["remark", "비고", "메모", "회사소개"]),
    ("name",
     ["company", "company name", "customer", "vendor", "supplier", "maker",
      "manufacturer", "name", "firm", "party", "회사", "회사명", "거래처", "거래처명",
      "상호", "상호명", "업체", "업체명", "제조사", "메이커", "고객사", "공급사"],
     ["company name", "company", "customer name", "vendor name", "maker name",
      "회사명", "거래처", "상호", "업체명", "제조사"]),
]


def _norm_header(h: Any) -> str:
    """열 이름 비교용 — 소문자, 구두점은 공백, 공백은 하나로. 'E-Mail' 과 'e mail' 을 같게."""
    t = re.sub(r"[^0-9a-z가-힣]+", " ", str(h or "").lower())
    return " ".join(t.split())


def _match_field(header: Any, allowed: set) -> Optional[str]:
    h = _norm_header(header)
    if not h:
        return None
    for field, exact, _ in _HEADERS:
        if field in allowed and h in exact:
            return field
    for field, _, contains in _HEADERS:
        if field in allowed and any(k in h for k in contains):
            return field
    return None


def auto_map(headers: List[Any], kind: str) -> List[str]:
    """열마다 무슨 칸인지 — 못 알아본 열은 빈 문자열(무시). 같은 칸에 열이 여럿이면
    여러 값 칸(이메일·전화)만 모두 살리고, 한 값 칸은 첫 열만 쓴다."""
    allowed = {k for k, _, _, _ in FIELDS[kind]}
    multi = {k for k, _, m, _ in FIELDS[kind] if m}
    out: List[str] = []
    used: set = set()
    for h in headers:
        f = _match_field(h, allowed)
        if f and f not in multi and f in used:
            f = None
        if f:
            used.add(f)
        out.append(f or "")
    return out


# ── 파일에서 표 꺼내기 ────────────────────────────────────────────────────────
def _cells_from_xlsx(raw: bytes) -> List[List[str]]:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    ws = wb.worksheets[0]
    grid: List[List[str]] = []
    for r, row in enumerate(ws.iter_rows(values_only=True)):
        if r >= MAX_ROWS + HEADER_SCAN_ROWS:
            break
        grid.append(["" if c is None else str(c).strip() for c in row[:MAX_COLS]])
    return grid


def _cells_from_csv(raw: bytes) -> List[List[str]]:
    text = ""
    for enc in ("utf-8-sig", "cp949", "euc-kr", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = list(csv.reader(io.StringIO(text)))
    return [[(c or "").strip() for c in r[:MAX_COLS]] for r in rows[: MAX_ROWS + HEADER_SCAN_ROWS]]


def read_sheet(raw: bytes, filename: str, kind: str) -> Dict[str, Any]:
    """파일 → {headers, rows}. 머리줄은 '알아본 칸이 가장 많은 줄'로 찾는다.

    첫 줄이 곧 머리줄이라고 못 박지 않는 이유: 이 시스템이 내보낸 명부 엑셀은 1행이
    제목, 2행이 부제, 4행이 머리줄이다. 내보낸 파일을 고쳐 그대로 올리는 것이 가장
    흔한 쓰임이 될 텐데, 그 파일이 안 읽히면 앞뒤가 안 맞는다."""
    name = (filename or "").lower()
    if name.endswith(".csv"):
        grid = _cells_from_csv(raw)
    elif name.endswith((".xlsx", ".xlsm", ".xls")):
        grid = _cells_from_xlsx(raw)
    else:
        raise ValueError("Only Excel (.xlsx) or CSV files can be uploaded.")

    best_i, best_score = -1, 0
    for i, row in enumerate(grid[:HEADER_SCAN_ROWS]):
        hit = sum(1 for f in auto_map(row, kind) if f)
        # 회사명 칸을 못 찾은 줄은 머리줄일 수 없다 — 이름 없이는 한 줄도 못 만든다.
        if "name" not in auto_map(row, kind):
            continue
        if hit > best_score:
            best_i, best_score = i, hit
    if best_i < 0 or best_score < 1:
        raise ValueError(
            "Could not find the column names. Check that the first row (or the table "
            "header row) carries names such as Company, Contact or Email."
        )

    headers = grid[best_i]
    width = len(headers)
    rows: List[List[str]] = []
    for row in grid[best_i + 1:]:
        vals = (row + [""] * width)[:width]
        if any(v for v in vals):
            rows.append(vals)
        if len(rows) >= MAX_ROWS:
            break
    return {"headers": headers, "rows": rows, "header_row": best_i + 1}


# ── 값 다듬기 ────────────────────────────────────────────────────────────────
# 한 칸에 값을 여러 개 몰아 적는 일이 흔하다("a@x.com, b@x.com"). 칸마다 쪼개는 자가
# 다르다 — 주소는 쉼표로 쪼개면 안 된다("12 Main St, Singapore" 는 주소 하나다).
_SPLIT = {
    "emails": re.compile(r"[,;\n/]+"),
    "phones": re.compile(r"[,;\n]+"),
    "regions": re.compile(r"[,;\n·]+"),
    "addresses": re.compile(r"[\n]+|\s+/\s+"),
}


def _split(field: str, text: str) -> List[str]:
    parts = _SPLIT[field].split(text) if field in _SPLIT else [text]
    out, seen = [], set()
    for p in parts:
        v = " ".join(str(p).split())
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out


def row_values(kind: str, mapping: List[str], row: List[str]) -> Dict[str, Any]:
    """한 줄 → {칸: 값}. 여러 값 칸은 리스트, 한 값 칸은 문자열(첫 번째로 채워진 열)."""
    multi = {k for k, _, m, _ in FIELDS[kind] if m}
    out: Dict[str, Any] = {k: ([] if k in multi else "") for k, _, _, _ in FIELDS[kind]}
    for ci, field in enumerate(mapping):
        if not field or field not in out or ci >= len(row):
            continue
        raw = " ".join(str(row[ci] or "").split()) if field not in _SPLIT else str(row[ci] or "")
        if not raw.strip():
            continue
        if field in multi:
            for v in _split(field, raw):
                if v.lower() not in {x.lower() for x in out[field]}:
                    out[field].append(v)
        elif not out[field]:
            out[field] = " ".join(raw.split())
    return out


# ── 같은 것인가 ──────────────────────────────────────────────────────────────
# 붙여 쓴 법인격은 회사 이름의 일부가 아니다 — "AMCL Co., Ltd" 와 "AMCL" 은 한 회사다.
# 다만 여기서 멈춘다. 'group'·'marine' 같은 낱말까지 떼면 서로 다른 회사가 한 줄로
# 합쳐지는데, 잘못 합친 것은 되돌릴 수 없고 잘못 나눈 것은 미리보기에서 눈에 띈다.
_LEGAL = re.compile(
    r"\b(co\s*ltd|co|ltd|limited|inc|incorporated|corp|corporation|pte\s*ltd|pte|"
    r"llc|gmbh|pty\s*ltd|pty|plc|bv|nv|sarl|srl|주식회사|유한회사)\b"
)


def norm_company(name: str) -> str:
    t = re.sub(r"[^0-9a-z가-힣]+", " ", str(name or "").lower())
    t = _LEGAL.sub(" ", t)
    return " ".join(t.split())


def norm_person(name: str) -> str:
    return " ".join(re.sub(r"[^0-9a-z가-힣]+", " ", str(name or "").lower()).split())


def row_key(kind: str, values: Dict[str, Any]) -> Tuple[str, str]:
    """명부에서 한 줄을 가리키는 자연키. 거래선은 레코드 1건 = 담당자 1명이라
    회사명만으로는 줄을 특정하지 못한다(AMCL 한 회사가 다섯 줄이다)."""
    company = norm_company(values.get("name", ""))
    if kind == "makers":
        return (company, "")
    return (company, norm_person(values.get("contact", "")))


# ── 겹쳐 보기 ────────────────────────────────────────────────────────────────
def _disp(v: Any) -> str:
    return ", ".join(v) if isinstance(v, list) else str(v or "")


def diff(kind: str, current: Dict[str, Any], values: Dict[str, Any],
         overwrite: bool) -> List[Dict[str, Any]]:
    """지금 값(current)에 엑셀 값(values)을 겹쳤을 때 실제로 바뀌는 것만 돌려준다.

    미리보기와 저장이 이 함수 하나를 같이 쓴다 — 눈으로 본 것이 곧 저장되는 것이라야
    미리보기가 확인이 된다."""
    changes: List[Dict[str, Any]] = []
    for key, label, multi, _ in FIELDS[kind]:
        new = values.get(key)
        if not new:
            continue
        cur = current.get(key) or ([] if multi else "")
        if multi:
            have = {str(x).lower() for x in cur}
            if overwrite:
                if [str(x).lower() for x in cur] == [str(x).lower() for x in new]:
                    continue
                merged = list(new)
            else:
                add = [v for v in new if v.lower() not in have]
                if not add:
                    continue
                merged = list(cur) + add
            changes.append({"field": key, "label": label, "multi": True,
                            "from": _disp(cur), "to": _disp(merged), "value": merged})
        else:
            cur_s = str(cur or "").strip()
            if cur_s and not overwrite:
                continue
            if cur_s == str(new).strip():
                continue
            changes.append({"field": key, "label": label, "multi": False,
                            "from": cur_s, "to": str(new), "value": str(new)})
    return changes


def build_plan(kind: str, headers: List[str], rows: List[List[str]], mapping: List[str],
               existing: List[Dict[str, Any]], overwrite: bool) -> Dict[str, Any]:
    """엑셀 줄마다 무슨 일이 생기는지 — new / update / same / error 넷 중 하나."""
    if kind not in FIELDS:
        raise ValueError("Unknown list type.")
    if "name" not in mapping:
        raise ValueError("Pick the company-name column — no row can be created without a name.")

    by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for rec in existing:
        by_key.setdefault(row_key(kind, rec), rec)
    # 같은 회사의 기존 줄 — 새 담당자가 회사 단위 값을 물려받을 곳.
    mates: Dict[str, List[Dict[str, Any]]] = {}
    for rec in existing:
        mates.setdefault(norm_company(rec.get("name", "")), []).append(rec)

    company_fields = [k for k, _, _, co in FIELDS[kind] if co]
    seen: Dict[Tuple[str, str], int] = {}
    out: List[Dict[str, Any]] = []

    for i, row in enumerate(rows):
        values = row_values(kind, mapping, row)
        name = values.get("name", "").strip()
        entry: Dict[str, Any] = {
            "i": i, "name": name, "contact": values.get("contact", ""),
            "action": "new", "target_id": None, "error": "", "changes": [],
            "inherited": [], "joined": False,
        }
        if not name:
            entry.update(action="error", error="The company name is empty.")
            out.append(entry)
            continue

        key = row_key(kind, values)
        if key in seen:
            entry.update(
                action="error",
                error=f"The same company and contact is already on row {seen[key] + 1} of this file.")
            out.append(entry)
            continue
        seen[key] = i

        target = by_key.get(key)
        if target:
            # 회사명은 고치지 않는다. 이름은 값이 아니라 그 줄이 누구인지 그 자체이고,
            # 목록은 이름이 글자까지 같은 줄끼리 회사로 묶는다 — 한 줄만 "AMCL Co., Ltd"
            # 로 바뀌면 그 담당자만 딴 회사로 떨어져 나간다. 회사명 바꾸기는 Company info
            # 창이 회사 전체를 한꺼번에 고치는 제 일이 따로 있다.
            changes = [c for c in diff(kind, target, values, overwrite) if c["field"] != "name"]
            entry.update(action="update" if changes else "same",
                         target_id=target.get("id"), changes=changes)
        else:
            # 새 줄 — 엑셀이 비워 둔 회사 단위 칸은 같은 회사의 기존 줄에서 물려받는다.
            siblings = mates.get(key[0], [])
            if siblings:
                # 이미 아는 회사에 담당자가 하나 더 붙는 것이라면 회사명은 명부에 적힌
                # 철자를 그대로 쓴다. 엑셀에 "AMCL Co., Ltd (Hong Kong)" 라 적혀 있다고
                # 그 철자로 새 줄을 만들면, 같은 회사인데 목록에서 두 묶음으로 갈린다.
                canon = siblings[0].get("name") or name
                if canon != name:
                    values["name"] = canon
                    entry["name"] = canon
                    entry["joined"] = True
                for f in company_fields:
                    if values.get(f):
                        continue
                    got = next((sib.get(f) for sib in siblings if sib.get(f)), None)
                    if got:
                        values[f] = list(got) if isinstance(got, list) else got
                        entry["inherited"].append(f)
            entry["changes"] = diff(kind, {}, values, True)
        entry["values"] = values
        out.append(entry)

    summary = {k: sum(1 for e in out if e["action"] == k)
               for k in ("new", "update", "same", "error")}
    return {"kind": kind, "title": TITLE[kind], "rows": out, "summary": summary,
            "headers": headers, "mapping": mapping, "fields": field_specs(kind)}
