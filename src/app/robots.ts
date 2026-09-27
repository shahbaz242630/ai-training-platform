import type { MetadataRoute } from "next";

/**
 * The booking desk only (founder, 2026-09-27; see SEARCH in config/site.ts).
 * Every page carries noindex, so crawlers are let in to read it: a page a
 * crawler is refused never shows it the noindex, and its bare address can
 * still be listed. The API is not for crawlers. No sitemap: no page here
 * belongs in search. The same in every environment, so staging cannot differ.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: "/api/" }] };
}
