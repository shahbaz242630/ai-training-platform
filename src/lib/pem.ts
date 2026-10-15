/**
 * A PEM certificate rebuilt from however a settings box stored it.
 *
 * Hostinger's environment variable box is a single line, so the database CA
 * certificate pasted into it arrives with its line breaks turned into spaces,
 * removed, or written as literal `\n`. OpenSSL refuses a PEM whose BEGIN and
 * END markers are not on lines of their own, and production refuses to
 * connect without a certificate it can use - so a correctly configured
 * certificate would take the booking site down.
 *
 * Each BEGIN/END block is rebuilt in the canonical form: markers on their own
 * lines, the base64 body wrapped at 64 characters. Nothing about WHICH
 * certificate is trusted changes; only its layout. A value with no complete
 * block is returned untouched, for the driver to accept or refuse.
 *
 * `scripts/db-connection.mjs` carries a copy (plain Node, no path aliases);
 * its test holds the two to identical behaviour.
 */

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
const LINE_LENGTH = 64;

export function normalisePem(value: string): string {
  const unescaped = value.replace(/\\n/g, "\n");
  const blocks = [...unescaped.matchAll(PEM_BLOCK)];
  if (blocks.length === 0) return value;

  return blocks
    .map(([, label, body]) => {
      const base64 = (body ?? "").replace(/\s+/g, "");
      const lines: string[] = [];
      for (let start = 0; start < base64.length; start += LINE_LENGTH) {
        lines.push(base64.slice(start, start + LINE_LENGTH));
      }
      return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join("\n");
    })
    .join("\n");
}
