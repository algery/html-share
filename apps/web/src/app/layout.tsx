import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ManagementShell } from "../components/management-shell";

import "./globals.css";

declare global {
  interface Window {
    dd: unknown;
  }
}

export const metadata: Metadata = {
  description: "HTML Share 管理端",
  title: "HTML Share",
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>
        <ManagementShell apiUrl={process.env["NEXT_PUBLIC_API_URL"] ?? ""}>
          {children}
        </ManagementShell>
      </body>
    </html>
  );
}
