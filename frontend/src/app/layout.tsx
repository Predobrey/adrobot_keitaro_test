import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Adrobot — управление кампаниями Keitaro",
  description: "Создание кампаний и управление долями офферов в Keitaro",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
