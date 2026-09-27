/**
 * Read a request body as text, refusing one larger than `maxBytes`.
 *
 * A public route that must read its body before it can check a signature (the
 * Stripe webhook) would otherwise read whatever it was sent into memory. The
 * limit is enforced twice: on a declared Content-Length before reading, and
 * while streaming, so a chunked body with no length is cut off as soon as it
 * passes the limit rather than after it has all arrived (security audit,
 * 2026-09-27).
 *
 * The bytes are decoded only once they are all in hand, so a multi-byte
 * character split across chunks is decoded correctly.
 */
export async function readTextWithin(
  request: Request,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };

  if (request.body === null) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
