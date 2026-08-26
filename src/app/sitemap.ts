import type { MetadataRoute } from "next";
import { clientEnv } from "@/lib/env";
import { isPubliclyConfigured } from "@/config/site";

/**
 * Public, indexable pages only. Booking routes and legal placeholders are
 * excluded. Empty until the site is genuinely live.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!isPubliclyConfigured()) return [];

  const base = clientEnv.NEXT_PUBLIC_SITE_URL;

  return [
    { url: `${base}/`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/training`, changeFrequency: "weekly", priority: 1 },
  ];
}
