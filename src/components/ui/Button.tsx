import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "onDeep";

const STYLES: Record<Variant, string> = {
  primary: "bg-ink text-on-deep hover:bg-deep-soft",
  secondary: "bg-transparent text-ink border border-line-strong hover:bg-chip",
  onDeep: "bg-on-deep text-ink hover:bg-chip",
};

/**
 * All CTAs are links, never buttons - they navigate. Using a real anchor keeps
 * keyboard behaviour, middle-click and "open in new tab" working for free.
 * Every button is a pill, as on zaaheen.com.
 */
export function ButtonLink({
  href,
  children,
  variant = "primary",
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: Variant;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center rounded-full px-7 py-3.5 text-base font-medium whitespace-nowrap transition-colors duration-150 ${STYLES[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
