import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "onDeep";

const STYLES: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-deep-soft",
  secondary: "bg-surface text-ink border border-line-strong hover:border-ink hover:bg-raised",
  onDeep: "bg-white text-ink hover:bg-on-deep",
};

/**
 * All CTAs are links, never buttons - they navigate. Using a real anchor keeps
 * keyboard behaviour, middle-click and "open in new tab" working for free.
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
      className={`inline-flex items-center justify-center rounded-lg px-6 py-3.5 text-sm font-semibold transition-colors duration-150 ${STYLES[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
