import type { MetadataRoute } from "next";
import { clientEnv } from "@/lib/env";
import { isIndexable } from "@/config/site";

/**
 * SAFETY: the whole site is disallowed unless this is a production build AND a
 * real company identity exists.
 *
 * Staging runs on a throwaway host domain. Letting it be indexed would put
 * duplicate content in front of our own real domain, and de-indexing a domain
 * afterwards is slow and never complete. Placeholder identity must never be
 * cached either. Both switches flip automatically - neither is manual.
 */
export default function robots(): MetadataRoute.Robots {
  if (!isIndexable(clientEnv.NEXT_PUBLIC_SITE_ENV)) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/training/book/", "/api/"] }],
    sitemap: `${clientEnv.NEXT_PUBLIC_SITE_URL}/sitemap.xml`,
  };
}
