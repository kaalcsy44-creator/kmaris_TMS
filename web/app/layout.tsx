import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KTMS Admin — RFQ & Quotation",
  description: "K-Maris TMS admin (Next.js pilot)",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
