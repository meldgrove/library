import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Meldgrove Library", template: "%s · Meldgrove Library" },
  description: "Studies, reports, and articles your organization found useful, each with a checked summary.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request: the CSP nonce is new for each response,
  // and almost every page depends on the session.
  await connection();
  return (
    <html lang="en-US">
      <body>{children}</body>
    </html>
  );
}
