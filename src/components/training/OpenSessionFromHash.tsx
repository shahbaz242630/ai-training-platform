"use client";

import { useEffect } from "react";

/**
 * Makes session detail deep-linkable: /training#ai-agents opens that
 * session's panel so ads and emails can point at a single session.
 *
 * Progressive enhancement - with JS disabled the anchor still scrolls to the
 * right session, the panel simply stays collapsed. Nothing is rendered.
 */
export function OpenSessionFromHash() {
  useEffect(() => {
    const open = () => {
      const slug = window.location.hash.slice(1);
      if (!slug) return;
      const panel = document.getElementById(`${slug}-detail`);
      if (panel instanceof HTMLDetailsElement) {
        panel.open = true;
        document.getElementById(slug)?.scrollIntoView({ block: "start" });
      }
    };

    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  return null;
}
