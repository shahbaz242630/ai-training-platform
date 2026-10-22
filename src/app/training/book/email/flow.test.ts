import { describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "@/data/db";
import { createEmailLinkToken } from "@/lib/email-link";
import { actOnEmailLink, isUsableLink, type EmailLinkDeps } from "./flow";

const SECRET = "s".repeat(32);
const CUSTOMER = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const NOW = new Date("2026-10-22T10:00:00Z");

/** A database stand-in that records every statement and answers updates. */
function fakeDeps(rows: unknown[] = [{ id: CUSTOMER }]) {
  const statements: { text: string; params: readonly unknown[] }[] = [];
  const runner: QueryRunner = {
    query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
      statements.push({ text, params });
      return { rows: rows as never[] };
    }),
  };
  const deps: EmailLinkDeps = {
    transaction: (work) => work(runner),
    now: NOW,
    secret: SECRET,
  };
  return { deps, statements };
}

const token = (purpose: "confirm" | "unsubscribe") =>
  createEmailLinkToken({ purpose, customerId: CUSTOMER }, SECRET);

describe("the buttons behind our email links", () => {
  it("confirms the customer the link names", async () => {
    const { deps, statements } = fakeDeps();
    const result = await actOnEmailLink("confirm", { token: token("confirm") }, deps);
    expect(result).toEqual({ ok: true, customerId: CUSTOMER, changed: true });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.text).toContain("marketing_consent_confirmed_at");
    expect(statements[0]!.params).toEqual([CUSTOMER, NOW]);
  });

  it("says nothing changed when the confirmation was already on record", async () => {
    const { deps } = fakeDeps([]);
    const result = await actOnEmailLink("confirm", { token: token("confirm") }, deps);
    expect(result).toEqual({ ok: true, customerId: CUSTOMER, changed: false });
  });

  it("unsubscribes the customer the link names", async () => {
    const { deps, statements } = fakeDeps();
    const result = await actOnEmailLink("unsubscribe", { token: token("unsubscribe") }, deps);
    expect(result.ok).toBe(true);
    expect(statements[0]!.text).toContain("unsubscribed_at");
    expect(statements[0]!.params).toEqual([CUSTOMER, NOW]);
  });

  it("does nothing at all for a link of the other kind, a bad link, or no secret", async () => {
    const cases: [Parameters<typeof actOnEmailLink>[0], unknown, string | null][] = [
      ["unsubscribe", { token: token("confirm") }, SECRET],
      ["confirm", { token: token("unsubscribe") }, SECRET],
      ["confirm", { token: "e1.confirm.nope.nope" }, SECRET],
      ["confirm", { token: "" }, SECRET],
      ["confirm", { token: "x".repeat(500) }, SECRET],
      ["confirm", null, SECRET],
      ["confirm", { token: token("confirm") }, null],
    ];
    for (const [purpose, raw, secret] of cases) {
      const { deps, statements } = fakeDeps();
      expect(await actOnEmailLink(purpose, raw, { ...deps, secret })).toEqual({ ok: false });
      expect(statements).toHaveLength(0);
    }
  });

  it("only shows the button for a link that would work", () => {
    expect(isUsableLink(token("confirm"), "confirm", SECRET)).toBe(true);
    expect(isUsableLink(token("confirm"), "unsubscribe", SECRET)).toBe(false);
    expect(isUsableLink(undefined, "confirm", SECRET)).toBe(false);
    expect(isUsableLink(["a", "b"], "confirm", SECRET)).toBe(false);
    expect(isUsableLink(token("confirm"), "confirm", null)).toBe(false);
  });
});
