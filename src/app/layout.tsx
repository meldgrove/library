import { Toaster } from "@meldgrove/ui/sonner";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Meldgrove Library", template: "%s · Meldgrove Library" },
  description: "Studies, reports, and articles your organization found useful, each with a checked summary.",
  robots: { index: false, follow: false },
};

/**
 * Sets the class `dark` before the page paints, as `useThemePreference` of
 * `@meldgrove/ui/theme` will (same storage key), so dark mode does not flash
 * light on load.
 */
const THEME_SCRIPT = `(function(){var t;try{t=localStorage.getItem("meldgrove.theme")}catch(e){}var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)})()`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request: the CSP nonce is new for each response,
  // and almost every page depends on the session.
  await connection();
  // Set by src/proxy.ts with the Content Security Policy.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // The theme script changes the class before React hydrates.
    <html lang="en-US" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
