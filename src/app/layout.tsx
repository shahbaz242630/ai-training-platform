import type { Metadata } from "next";
import localFont from "next/font/local";
import { clientEnv } from "@/lib/env";
import { isIndexable } from "@/config/site";
import "./globals.css";
import { companyName } from "@/config/site";

/*
  The Zaaheen fonts, self-hosted (SIL Open Font License; the licences sit next
  to the files). Local files, so no visitor request goes to a font service.
*/
const plexSans = localFont({
  src: "./fonts/plex-sans-var.woff2",
  variable: "--font-plex-sans",
  weight: "100 700",
  display: "swap",
});
const plexMono = localFont({
  src: "./fonts/plex-mono-400.woff2",
  variable: "--font-plex-mono",
  weight: "400",
  display: "swap",
});
const newsreader = localFont({
  src: "./fonts/newsreader-var.woff2",
  variable: "--font-newsreader",
  weight: "200 800",
  display: "swap",
});

const INDEXABLE = isIndexable(clientEnv.NEXT_PUBLIC_SITE_ENV);

export const metadata: Metadata = {
  title: {
    default: "Private 1-to-1 AI Training — Dubai",
    template: `%s — ${companyName()}`,
  },
  description:
    "Private 1-to-1 practical AI training and implementation coaching in Dubai. Research, prompting, coding agents, AI agents, technology stacks and production deployment.",
  /*
    Site-wide no-index unless this is a production build carrying a real
    identity. Belt and braces with robots.ts: robots.txt is a request that
    crawlers may ignore, whereas a meta robots tag is honoured per page. Both
    flip from the same condition, so they cannot disagree.
  */
  robots: INDEXABLE ? { index: true, follow: true } : { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
