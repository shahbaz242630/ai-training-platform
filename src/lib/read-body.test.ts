import { describe, it, expect } from "vitest";
import { readTextWithin } from "./read-body";

/*
  A public webhook route must not read an unbounded body into memory before it
  can check a signature (security audit, 2026-09-27). The limit is enforced
  while streaming, so a body with no Content-Length is cut off too.
*/
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://example.test/hook", { method: "POST", body, headers });

/** A body sent in chunks with no Content-Length, the way a chunked upload arrives. */
function chunked(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe("readTextWithin", () => {
  it("returns a body within the limit exactly as sent", async () => {
    expect(await readTextWithin(post('{"a":"é"}'), 1024)).toEqual({ ok: true, text: '{"a":"é"}' });
  });

  it("accepts a body of exactly the limit", async () => {
    expect(await readTextWithin(post("x".repeat(64)), 64)).toEqual({
      ok: true,
      text: "x".repeat(64),
    });
  });

  it("refuses a body over the limit", async () => {
    expect(await readTextWithin(post("x".repeat(65)), 64)).toEqual({ ok: false });
  });

  it("refuses on a declared Content-Length over the limit, before reading", async () => {
    const request = post("small", { "content-length": "1000000000" });
    expect(await readTextWithin(request, 64)).toEqual({ ok: false });
  });

  it("cuts off a chunked body with no Content-Length once it passes the limit", async () => {
    const request = new Request("https://example.test/hook", {
      method: "POST",
      body: chunked(["x".repeat(40), "x".repeat(40), "x".repeat(40)]),
      duplex: "half",
    } as RequestInit);
    expect(await readTextWithin(request, 64)).toEqual({ ok: false });
  });

  it("reads an empty body as empty", async () => {
    expect(await readTextWithin(post(null), 64)).toEqual({ ok: true, text: "" });
  });
});
