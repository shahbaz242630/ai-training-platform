import type { ReactNode } from "react";

/** The page width zaaheen.com uses: 1180px, 32px sides (22px on a phone). */
export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-[1180px] px-[22px] sm:px-8 ${className}`}>{children}</div>
  );
}
