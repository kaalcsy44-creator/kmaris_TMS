import type { Metadata, Viewport } from "next";
import "./globals.css";

// 링크 공유(Open Graph) 시 노출되는 사이트 전역 이름·설명. 특정 페이지(RFQ 등)가
// 아니라 앱 자체를 나타내야 하므로 앱 이름으로 고정한다. 개별 페이지가 자체 title 을
// 지정하면 "<페이지> · K-MARIS TMS" 형태로 확장된다(template).
const APP_NAME = "K-MARIS TMS";
const APP_DESC = "K-MARIS Trade Management System — 견적·발주·서류·정산 통합 관리";

export const metadata: Metadata = {
  metadataBase: new URL("https://ktms-web.vercel.app"),
  applicationName: APP_NAME,
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_DESC,
  openGraph: {
    title: APP_NAME,
    description: APP_DESC,
    siteName: APP_NAME,
    url: "/",
    type: "website",
    locale: "ko_KR",
  },
  twitter: {
    card: "summary",
    title: APP_NAME,
    description: APP_DESC,
  },
  // 사내 관리자 도구 — 검색엔진 색인 제외.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
