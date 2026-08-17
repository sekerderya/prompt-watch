import type { Metadata } from "next";
import Link from "next/link";
import Nav from "./components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "PromptWatch",
  description:
    "Observability for LLM prompts: versioning, A/B testing, cost, latency and error-rate tracking.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <div className="pw-shell">
          <header className="pw-header">
            <Link href="/" className="pw-brand">
              <span className="pw-brand__dot" aria-hidden="true" />
              PromptWatch
            </Link>
            <Nav />
          </header>
          <main className="pw-main">{children}</main>
        </div>
      </body>
    </html>
  );
}