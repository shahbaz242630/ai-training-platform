import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Private 1-to-1 AI Training — Dubai",
    template: "%s — [COMPANY_NAME]",
  },
  description:
    "Private 1-to-1 practical AI training and implementation coaching in Dubai. Research, prompting, coding agents, AI agents, technology stacks and production deployment.",
  // Site-wide no-index while the site still carries placeholder identity.
  // Removed at launch, together with the switch in robots.ts.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
