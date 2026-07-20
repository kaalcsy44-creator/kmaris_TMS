"""Download and create static Noto Sans KR fonts for PDF generation.

The upstream file is a *variable* font (NotoSansKR[wght].ttf). We pin it to
Regular (400) and Bold (700) static instances. It is critical that each static
file carries a DISTINCT internal name and the correct weight metadata:
ReportLab keys embedded fonts by their internal name, so if both instances kept
the variable font's default name ("NotoSansKR-Thin") ReportLab would embed only
one of them and render *every* run — including <b>/bold styles — in a single
weight (nothing appears bold). `updateFontNames=True` plus an explicit name /
OS-2 / macStyle rewrite guarantees two independent faces.
"""
from pathlib import Path
from urllib.request import urlopen

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


FONT_URL = (
    "https://raw.githubusercontent.com/google/fonts/"
    "ec0464b978de222073645d6d3366f3fdf03376d8/"
    "ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf"
)
FONT_DIR = Path(__file__).resolve().parent.parent / "config" / "fonts"
VARIABLE_FONT = FONT_DIR / "NotoSansKR-Variable.ttf"

# NameID -> (family, subfamily, full, postscript, unique)
_NAMES = {
    400: ("Noto Sans KR", "Regular", "Noto Sans KR", "NotoSansKR-Regular"),
    700: ("Noto Sans KR", "Bold", "Noto Sans KR Bold", "NotoSansKR-Bold"),
}


def _rename(font: TTFont, weight: int) -> None:
    family, subfamily, full, ps = _NAMES[weight]
    name = font["name"]
    for nid, value in (
        (1, family), (2, subfamily), (4, full), (6, ps),
        (16, family), (17, subfamily),
    ):
        name.setName(value, nid, 3, 1, 0x409)   # Windows / Unicode / en-US
        name.setName(value, nid, 1, 0, 0)       # Mac / Roman / en
    os2 = font["OS/2"]
    os2.usWeightClass = weight
    head = font["head"]
    if weight >= 700:
        os2.fsSelection = (os2.fsSelection & ~0x40) | 0x20   # clear REGULAR, set BOLD
        head.macStyle |= 0x01
    else:
        os2.fsSelection = (os2.fsSelection & ~0x20) | 0x40   # clear BOLD, set REGULAR
        head.macStyle &= ~0x01


def main() -> None:
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    if not VARIABLE_FONT.exists():
        with urlopen(FONT_URL, timeout=120) as response:
            VARIABLE_FONT.write_bytes(response.read())

    for weight, filename in ((400, "NotoSansKR-Regular.ttf"), (700, "NotoSansKR-Bold.ttf")):
        target = FONT_DIR / filename
        font = TTFont(VARIABLE_FONT)
        static_font = instantiateVariableFont(
            font, {"wght": weight}, inplace=False, updateFontNames=True
        )
        _rename(static_font, weight)
        static_font.save(target)


if __name__ == "__main__":
    main()
