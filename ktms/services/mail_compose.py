"""단계 이메일(2·4·6) 발송의 공통 조립부 — 본문·서명·첨부.

발송 화면(DocSendPanel)은 본문을 세 조각으로 나눠 보낸다:
    body      — 템플릿이 만든 인사말·안내문(사용자가 손댈 수 있음)
    notes     — 이번 건에만 덧붙일 문단(선택)
    signature — 서명(포함 여부 토글)
최종 메일 본문은 여기서 하나로 합친다. 세 단계가 같은 규칙을 쓰도록 이 모듈에 모은다.

첨부는 (1) 시스템이 생성한 문서(견적서 PDF/XLSX 등) + (2) 사용자가 그 자리에서 올린 파일.
업로드 파일은 보관하지 않고 발송 시에만 붙인다(마케팅 이메일과 동일한 방침).
"""
from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from fastapi import HTTPException, UploadFile

# SMTP/수신측 한도(Gmail 25MB)를 넘으면 발송이 조용히 실패하므로 미리 막는다.
# 인코딩(base64) 오버헤드 약 33% 를 감안해 원본 기준으로 여유를 둔 값.
MAX_ATTACH_TOTAL = 18 * 1024 * 1024

Attachment = Tuple[str, bytes]


def compose_body(body: str, notes: str = "", signature: str = "",
                 include_signature: bool = True) -> str:
    """본문 + 노트 + 서명 → 최종 메일 본문. 빈 조각은 건너뛰고 문단 사이는 빈 줄 하나."""
    parts = [(body or "").strip()]
    if (notes or "").strip():
        parts.append(notes.strip())
    if include_signature and (signature or "").strip():
        parts.append(signature.strip())
    return "\n\n".join(p for p in parts if p) + "\n"


def read_uploads(files: Optional[Sequence[UploadFile]]) -> List[Attachment]:
    """업로드된 파일을 (파일명, bytes) 로 읽는다. 빈 파일은 무시."""
    out: List[Attachment] = []
    for f in files or []:
        f.file.seek(0)
        data = f.file.read()
        if data:
            out.append((f.filename or "attachment", data))
    return out


def check_total_size(attachments: Sequence[Attachment]) -> None:
    """총 첨부 용량 확인. 초과하면 400 — 넘긴 채로 보내면 SMTP 단에서 실패한다."""
    total = sum(len(d) for _, d in attachments)
    if total > MAX_ATTACH_TOTAL:
        mb = MAX_ATTACH_TOTAL / 1024 / 1024
        raise HTTPException(
            status_code=400,
            detail=f"첨부 용량이 너무 큽니다({total / 1024 / 1024:.1f}MB) — 총 {mb:.0f}MB 이하로 줄여주세요.",
        )


def build_attachments(generated: Optional[Attachment],
                      files: Optional[Sequence[UploadFile]]) -> List[Attachment]:
    """생성 문서(먼저) + 업로드 파일 순으로 첨부 목록을 만들고 용량을 확인한다.
    generated=None 이면 문서 없이 본문만 보낸다(발송 화면에서 문서 첨부를 끈 경우)."""
    out: List[Attachment] = []
    if generated is not None:
        out.append(generated)
    out.extend(read_uploads(files))
    check_total_size(out)
    return out
