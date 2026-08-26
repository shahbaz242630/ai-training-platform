import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { clientEnv } from "@/lib/env";
import { isIndexable } from "@/config/site";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const INDEXABLE = isIndexable(clientEnv.NEXT_PUBLIC_SITE_ENV);

export const metadata: Metadata = {
  title: {
    default: "Private 1-to-1 AI Training — Dubai",
    template: "%s — [COMPANY_NAME]",
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
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
