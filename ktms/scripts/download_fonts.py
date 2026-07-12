"""Download and create static Noto Sans KR fonts for PDF generation."""
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


def main() -> None:
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    if not VARIABLE_FONT.exists():
        with urlopen(FONT_URL, timeout=120) as response:
            VARIABLE_FONT.write_bytes(response.read())

    for weight, filename in ((400, "NotoSansKR-Regular.ttf"), (700, "NotoSansKR-Bold.ttf")):
        target = FONT_DIR / filename
        if target.exists():
            continue
        font = TTFont(VARIABLE_FONT)
        static_font = instantiateVariableFont(font, {"wght": weight}, inplace=False)
        static_font.save(target)


if __name__ == "__main__":
    main()
