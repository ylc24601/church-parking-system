import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "內湖信友堂 停車管理",
  description: "內湖信友堂主日停車預約與現場點名系統",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Font is the system CJK stack set on <body> in globals.css — no next/font here:
  // Geist covers Latin only and would silently fall back for Chinese text.
  return (
    <html lang="zh-TW" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
