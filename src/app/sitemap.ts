import type { MetadataRoute } from "next";
import { clientEnv } from "@/lib/env";
import { isIndexable } from "@/config/site";

/**
 * Public, indexable pages only. Booking routes and legal placeholders are
 * excluded. Empty unless this is a production build with a real identity - a
 * sitemap advertising a staging domain is worse than no sitemap at all.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!isIndexable(clientEnv.NEXT_PUBLIC_SITE_ENV)) return [];

  const base = clientEnv.NEXT_PUBLIC_SITE_URL;

  return [
    { url: `${base}/`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/training`, changeFrequency: "weekly", priority: 1 },
  ];
}
