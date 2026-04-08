import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TTS Harness",
  description: "TTS Agent Harness — local production UI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
