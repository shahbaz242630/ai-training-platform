/** The small label above a heading: mono, sentence case, sage (zaaheen.com's eyebrow). */
export function SectionLabel({ children, onDeep = false }: { children: string; onDeep?: boolean }) {
  return (
    <p className={`mb-3.5 font-mono text-[13px] ${onDeep ? "text-on-deep-accent" : "text-accent"}`}>
      {children}
    </p>
  );
}
