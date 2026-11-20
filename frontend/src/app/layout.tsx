import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Adrobot — Keitaro Campaign Manager",
  description: "Create campaigns and manage offer shares in Keitaro",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
