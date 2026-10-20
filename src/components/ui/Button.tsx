import Link from "next/link";
import type { ReactNode } from "react";
import { loadsFully, prefetchFor } from "@/lib/link-prefetch";

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
  const classes = `inline-flex items-center justify-center rounded-full px-7 py-3.5 text-base font-medium whitespace-nowrap transition-colors duration-150 ${STYLES[variant]} ${className}`;
  // A booking page must be loaded in full so it gets its own security policy
  // (see loadsFully); a plain anchor does that, and never prefetches.
  if (loadsFully(href)) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} prefetch={prefetchFor(href)} className={classes}>
      {children}
    </Link>
  );
}
