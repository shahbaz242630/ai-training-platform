import { describe, it, expect } from "vitest";
import robots from "@/app/robots";
import { SEARCH } from "./site";

/**
 * The booking desk only (founder, 2026-09-27; zaaheen.com SEO-HANDOFF §1 6b).
 * The Knowledge Centre on zaaheen.com is the one page search and answer
 * engines should find for coaching; this app, where "Book your session"
 * lands, repeats its sessions and prices, so it must never compete with it.
 *
 * So no page here is ever indexable, in any environment: every page carries
 * noindex. robots.txt allows crawling on purpose, because a crawler that is
 * refused a page never sees its noindex and may list the bare address anyway
 * (both 2026-09-27 research reports). There is no sitemap: this host has no
 * page that belongs in one.
 */
describe("search indexing", () => {
  it("never asks to be indexed, and lets links be followed back to zaaheen.com", () => {
    expect(SEARCH).toEqual({ index: false, follow: true });
  });

  it("lets every crawler read the pages, so they see the noindex", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    expect(rules).toEqual([{ userAgent: "*", allow: "/", disallow: "/api/" }]);
  });

  it("advertises no sitemap", () => {
    expect(robots().sitemap).toBeUndefined();
  });
});

/*
  The same browser-tab icon as zaaheen.com (copied from its site/public), in
  the formats Google lists for favicons (ICO, PNG; not SVG alone), placed where
  Next.js links them by itself. It had none: /favicon.ico was a 404.
*/
describe("browser icon", () => {
  it("ships the ICO and PNG icons", async () => {
    const { existsSync } = await import("node:fs");
    for (const f of ["src/app/favicon.ico", "src/app/icon.png", "src/app/apple-icon.png"]) {
      expect(existsSync(f), f).toBe(true);
    }
  });
});
