import type { MetadataRoute } from "next";
import { clientEnv } from "@/lib/env";
import { isPubliclyConfigured } from "@/config/site";

/**
 * SAFETY: until a real production domain AND company identity are configured,
 * the entire site is disallowed.
 *
 * A half-built site carrying [COMPANY_NAME] placeholders must never be indexed.
 * Once search and answer engines cache placeholder content it is slow and
 * painful to undo. This flips automatically when config/site.ts becomes real.
 */
export default function robots(): MetadataRoute.Robots {
  if (!isPubliclyConfigured()) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/training/book/", "/api/"] }],
    sitemap: `${clientEnv.NEXT_PUBLIC_SITE_URL}/sitemap.xml`,
  };
}
