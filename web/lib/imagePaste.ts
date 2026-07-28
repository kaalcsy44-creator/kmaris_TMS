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

// 업로드 전 사진을 축소한다(명함 OCR 용). 스마트폰 사진은 수 MB·4000px 급이라
// 그대로 올리면 업로드가 느리고 비전 모델 입력 한도에도 걸린다. 긴 변 1600px·JPEG
// 이면 명함 글씨를 읽기에 충분하다. 이미지가 아니거나(PDF 등) 변환 실패 시 원본 반환.
export function downscaleImageFile(file: File, max = 1600): Promise<File> {
  if (!file.type.startsWith("image/")) return Promise.resolve(file);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(file);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(file);
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        if (scale === 1 && file.size <= 1_500_000) return resolve(file);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(file);
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => resolve(blob ? new File([blob], "card.jpg", { type: "image/jpeg" }) : file),
          "image/jpeg",
          0.9
        );
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
