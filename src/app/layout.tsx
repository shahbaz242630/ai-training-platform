import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { companyName, SEARCH } from "@/config/site";

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

export const metadata: Metadata = {
  title: {
    default: `Book private 1-to-1 AI coaching · ${companyName()}`,
    template: `%s · ${companyName()}`,
  },
  description:
    "Private 1-to-1 practical AI training and implementation coaching in Dubai. Research, prompting, coding agents, AI agents, technology stacks and production deployment.",
  /*
    Every page: noindex, follow (SEARCH in config/site.ts, the booking desk
    only). robots.ts lets crawlers in so they can read it.
  */
  robots: SEARCH,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
