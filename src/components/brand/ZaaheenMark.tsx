/**
 * The Zaaheen mark: a sage disc on a paper rim, cut by an ink Z. The same
 * geometry as the zaaheen.com logo and the desktop app's icon; change them
 * together. Decorative: the name always sits next to it as text.
 */
export function ZaaheenMark({ size = 48 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="26" fill="#faf8f3" />
      <circle cx="32" cy="32" r="24.4" fill="#7fae8e" />
      <path
        d="M22 23h20L22 41h20"
        fill="none"
        stroke="#26221c"
        strokeWidth="5.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
