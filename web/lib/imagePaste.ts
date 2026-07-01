"use client";

// 캡쳐/파일 이미지를 긴 변 기준으로 축소한 data URL(PNG)로 변환한다.
// 로고 저장 용량을 줄이려고 기본 160px 로 다운스케일한다(투명 배경 유지를 위해 PNG).
export function fileToLogoDataUrl(file: File, max = 160): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Invalid image"));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unsupported"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** 클립보드 이벤트에서 첫 이미지 파일을 꺼낸다(캡쳐 붙여넣기용). 없으면 null. */
export function imageFromClipboard(e: React.ClipboardEvent): File | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const it of Array.from(items)) {
    if (it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}
