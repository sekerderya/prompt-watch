import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "PromptWatch",
  description: "PromptWatch web",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 24,
  padding: "0 24px",
  height: 56,
  fontFamily: "system-ui, sans-serif",
  background: "#1e293b",
  color: "#e2e8f0",
};

const brandStyle: React.CSSProperties = {
  color: "#e2e8f0",
  textDecoration: "none",
  fontWeight: 700,
  fontSize: 18,
};

const navLinkStyle: React.CSSProperties = {
  color: "#cbd5e1",
  textDecoration: "none",
  fontSize: 14,
  padding: "6px 12px",
  borderRadius: 6,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <header style={headerStyle}>
          <Link href="/" style={brandStyle}>
            PromptWatch
          </Link>
          <nav style={{ display: "flex", gap: 8 }}>
            <Link href="/" style={navLinkStyle}>
              Dashboard
            </Link>
            <Link href="/ab-tests" style={navLinkStyle}>
              A/B Tests
            </Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}