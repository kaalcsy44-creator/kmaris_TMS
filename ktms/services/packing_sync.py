"""Proforma Invoice 의 Packing information ↔ Packing List 합계행(포장 규격) 동기화.

같은 사실(몇 개를 무엇에 담아 어떤 크기·무게로 보내는가)을 두 화면에서 따로 적던 것을 잇는다.
어느 쪽을 먼저(또는 나중에) 저장하든, 저장할 때 값이 바뀌었으면 다른 쪽을 그 값으로 맞춘다.

저장 자리
  PI  : terms.pi_packing_rows (JSON: [{type,w,d,h,gw,nw}] — 포장 하나에 한 줄)
        + 문서에 찍는 문장 pi_packing_total / pi_packages (화면 packTexts 와 같은 규칙)
  PL  : 그 CI 의 shipping 에 든 합계행 sm_total_cases·sm_pkg_kind·sm_net_weight·sm_gross_weight·
        sm_measurement·sm_dim_l·sm_dim_w·sm_dim_h (Shipping Mark 탭과 같은 칸)

짝
  CI 가 한 장   : PL 합계행 = PI 포장 전체(개수·무게 합, 용적 합, 크기는 한 개일 때만)
  CI 가 여러 장 : 포장별 분리 발행 — CI-k(PL-k) = PI 의 k번째 포장. PI 포장이 CI 보다 많으면
                  마지막 CI 가 남은 포장을 모두 맡는다.
  PL 합계행의 크기(L×W×H)는 '같은 상자 하나의 크기'(용적 = L×W×H×개수)다 — 그래서 개수가 여럿인
  합계행을 PI 로 옮길 때는 같은 크기의 포장 여럿으로 펴고, 무게는 개수로 똑같이 나눈다(Approx.).
"""
from __future__ import annotations

import json
import re

KEYS = {
    "cases": "sm_total_cases", "kind": "sm_pkg_kind", "nw": "sm_net_weight", "gw": "sm_gross_weight",
    "meas": "sm_measurement", "l": "sm_dim_l", "w": "sm_dim_w", "h": "sm_dim_h",
}
ROW_FIELDS = ("type", "w", "d", "h", "gw", "nw")


def _num(v) -> float | None:
    try:
        s = re.sub(r"[^0-9.\-]", "", str(v if v is not None else ""))
        return float(s) if s not in ("", "-", ".") else None
    except ValueError:
        return None


def _fmt(n: float | None) -> str:
    if n is None:
        return ""
    return f"{round(n, 3):g}"


def _cbm(l, w, h, n=1) -> float | None:
    a, b, c = _num(l), _num(w), _num(h)
    if not (a and b and c):
        return None
    return round(a * b * c * (n or 1) / 1_000_000, 4)


# ── PI 쪽 ─────────────────────────────────────────────────────────────────────

def pi_rows(terms: dict | None) -> list[dict]:
    try:
        v = json.loads((terms or {}).get("pi_packing_rows") or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(v, list):
        return []
    return [{k: str((x or {}).get(k) or "").strip() for k in ROW_FIELDS} for x in v if isinstance(x, dict)]


def _row_blank(r: dict) -> bool:
    return not any(r.get(k) for k in ROW_FIELDS)


def _plural(n: int, word: str) -> str:
    if n == 1:
        return f"1 {word}"
    return f"{n} {word}es" if re.search(r"(s|x|ch|sh)$", word, re.I) else f"{n} {word}s"


def pack_texts(rows: list[dict]) -> tuple[str, str]:
    """화면 packTexts 와 같은 문장 — (pi_packing_total, pi_packages)."""
    counts: dict[str, int] = {}
    for r in rows:
        t = r.get("type", "").strip()
        if t:
            counts[t] = counts.get(t, 0) + 1
    kinds = " + ".join(_plural(n, t) for t, n in counts.items())
    n = len(rows)
    total = f"{n} Package{'' if n == 1 else 's'}" + (f" ({kinds})" if kinds else "")
    lines = []
    for r in rows:
        bits = []
        dims = [r.get(k, "").strip() for k in ("w", "d", "h")]
        if all(dims):
            bits.append(" × ".join(dims) + " cm")
        if r.get("gw"):
            bits.append(f"Approx. {r['gw']} kg G/W")
        if r.get("nw"):
            bits.append(f"Approx. {r['nw']} kg N/W")
        lines.append(" / ".join(bits))
    return total, "\n".join(lines)


def _groups(rows: list[dict], n_ci: int) -> list[list[dict]]:
    """PI 포장을 CI 수만큼 나눈다 — k번째 CI 가 k번째 포장, 마지막 CI 가 나머지 전부."""
    if n_ci <= 1:
        return [rows]
    out = [[rows[k]] if k < len(rows) else [] for k in range(n_ci - 1)]
    out.append(rows[n_ci - 1:] if len(rows) >= n_ci else [])
    return out


# ── PL(합계행) 쪽 ──────────────────────────────────────────────────────────────

def totals_of(shipping: dict | None) -> dict:
    sh = shipping or {}
    return {k: str(sh.get(v) or "").strip() for k, v in KEYS.items()}


def _has_totals(t: dict) -> bool:
    return any(t.get(k) for k in ("cases", "kind", "nw", "gw", "meas", "l", "w", "h"))


def totals_from_rows(rows: list[dict]) -> dict:
    """PI 포장 여러 줄 → PL 합계행 한 줄."""
    rows = [r for r in rows if not _row_blank(r)]
    if not rows:
        return {}
    types = {r["type"] for r in rows if r.get("type")}
    gws = [_num(r.get("gw")) for r in rows]
    nws = [_num(r.get("nw")) for r in rows]
    cbms = [_cbm(r.get("w"), r.get("d"), r.get("h")) for r in rows]
    one = len(rows) == 1
    same_size = len({(r.get("w"), r.get("d"), r.get("h")) for r in rows}) == 1
    return {
        "cases": str(len(rows)),
        "kind": next(iter(types)) if len(types) == 1 else "",
        "gw": _fmt(sum(x for x in gws if x is not None)) if any(x is not None for x in gws) else "",
        "nw": _fmt(sum(x for x in nws if x is not None)) if any(x is not None for x in nws) else "",
        # 크기는 모두 같은 상자일 때만 싣는다(합계행 크기 = 상자 하나의 크기).
        "l": rows[0].get("w", "") if (one or same_size) else "",
        "w": rows[0].get("d", "") if (one or same_size) else "",
        "h": rows[0].get("h", "") if (one or same_size) else "",
        "meas": f"{round(sum(x for x in cbms if x), 4):g}" if any(cbms) else "",   # 화면 cbmText 와 같은 4자리
    }


def rows_from_totals(t: dict) -> list[dict]:
    """PL 합계행 → PI 포장 줄(개수만큼, 같은 크기, 무게는 똑같이 나눔)."""
    if not _has_totals(t):
        return []
    n = int(_num(t.get("cases")) or 1)
    n = max(1, min(n, 30))
    gw, nw = _num(t.get("gw")), _num(t.get("nw"))
    row = {
        "type": t.get("kind", ""), "w": t.get("l", ""), "d": t.get("w", ""), "h": t.get("h", ""),
        "gw": _fmt(gw / n if gw is not None else None), "nw": _fmt(nw / n if nw is not None else None),
    }
    return [dict(row) for _ in range(n)]


# ── 동기화 ────────────────────────────────────────────────────────────────────

def _set_ci_totals(ci, t: dict) -> None:
    sh = dict(ci.shipping or {})
    for k, key in KEYS.items():
        sh[key] = t.get(k, "")
    ci.shipping = sh


def push_pi_to_cis(pi, cis: list) -> int:
    """PI 포장 → 각 CI 의 PL 합계행. 바꾼 CI 수."""
    rows = [r for r in pi_rows(pi.terms) if not _row_blank(r)]
    if not rows or not cis:
        return 0
    changed = 0
    for ci, grp in zip(cis, _groups(rows, len(cis))):
        if not grp:
            continue
        t = totals_from_rows(grp)
        if t and t != {k: v for k, v in totals_of(ci.shipping).items()}:
            _set_ci_totals(ci, t)
            changed += 1
    return changed


def push_cis_to_pi(pi, cis: list) -> bool:
    """각 CI 의 PL 합계행 → PI 포장 줄. 합계행이 빈 CI 는 PI 의 해당 포장을 그대로 둔다."""
    if pi is None or not cis:
        return False
    old_rows = [r for r in pi_rows(pi.terms) if not _row_blank(r)]
    old_groups = _groups(old_rows, len(cis))
    new_rows: list[dict] = []
    for ci, grp in zip(cis, old_groups):
        t = totals_of(ci.shipping)
        if not _has_totals(t) or (grp and t == totals_from_rows(grp)):
            # 비었거나, PI 포장에서 나온 합계 그대로면 PI 쪽 세부(포장마다 다른 크기·무게)를 지킨다.
            new_rows += grp
        else:
            new_rows += rows_from_totals(t)
    if not new_rows or new_rows == old_rows:
        return False
    total, packages = pack_texts(new_rows)
    terms = dict(pi.terms or {})
    first_time = not terms.get("pi_packing_rows")
    terms.update(pi_packing_rows=json.dumps(new_rows, ensure_ascii=False),
                 pi_packing_total=total, pi_packages=packages)
    if first_time:
        terms["pi_packing_on"] = "1"   # PL 에 먼저 적었으면 PI 에도 찍히게 켠다(끄는 건 사람 몫)
    pi.terms = terms
    return True


def fill_views(pi_terms: dict | None, ci_shippings: list[dict]) -> tuple[dict | None, list[dict]]:
    """화면에 보낼 값만 채운다(저장하지 않는다) — 한쪽만 적혀 있으면 빈 쪽에 그 값을 보여 준다.

    이 기능 전에 PI 에만(또는 PL 에만) 적어 둔 딜도 열면 바로 연동된 값이 보이고, 그 화면을
    저장하면 그대로 남는다. 둘 다 적혀 있으면 손대지 않는다(저장 때 동기화가 맞춘다)."""
    rows = [r for r in pi_rows(pi_terms) if not _row_blank(r)]
    totals = [totals_of(sh) for sh in ci_shippings]
    out_sh = [dict(sh or {}) for sh in ci_shippings]
    if rows and ci_shippings:
        for i, grp in enumerate(_groups(rows, len(ci_shippings))):
            if grp and not _has_totals(totals[i]):
                t = totals_from_rows(grp)
                for k, key in KEYS.items():
                    out_sh[i][key] = t.get(k, "")
    out_terms = pi_terms
    if pi_terms is not None and not rows and any(_has_totals(t) for t in totals):
        new_rows = [r for t in totals for r in rows_from_totals(t)]
        if new_rows:
            total, packages = pack_texts(new_rows)
            out_terms = {**pi_terms, "pi_packing_rows": json.dumps(new_rows, ensure_ascii=False),
                         "pi_packing_total": total, "pi_packages": packages}
    return out_terms, out_sh
