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
  description: "Demo Share 管理端",
  title: "Demo Share",
  icons: {
    icon: { url: "/brand/demo-share-icon.png", type: "image/png", sizes: "32x32" },
    apple: { url: "/brand/demo-share-apple-icon.png", type: "image/png", sizes: "180x180" },
  },
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
