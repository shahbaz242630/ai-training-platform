import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactLink, contactLine } from "./ContactLink";
import { SITE } from "@/config/site";

/**
 * "Get in touch" used to appear on the booking pages with nowhere to go: no
 * link, no address. Every way of asking a customer to contact us now goes
 * through ContactLink (in a page) or contactLine (in a plain-text message),
 * and both carry the booking desk's real address.
 */
describe("ContactLink", () => {
  it("is a mailto link to the booking desk's address", () => {
    const html = renderToStaticMarkup(<ContactLink />);
    expect(html).toContain(`href="mailto:${SITE.supportEmail}"`);
    expect(html).toContain(">get in touch</a>");
  });

  it("names the address when asked, so it can be read or copied", () => {
    const html = renderToStaticMarkup(<ContactLink showAddress />);
    expect(html).toContain(`>${SITE.supportEmail}</a>`);
  });
});

describe("contactLine", () => {
  it("names the real address in plain text", () => {
    expect(contactLine()).toBe(`email ${SITE.supportEmail}`);
  });
});

describe("no dead 'get in touch' left in customer-facing code", () => {
  it("appears only inside ContactLink itself", async () => {
    const { readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");

    const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(
        (p) =>
          /^src\/(app|components|config|domain)\/.*\.(ts|tsx)$/.test(p) &&
          !p.includes(".test.") &&
          !p.endsWith("src/components/ui/ContactLink.tsx"),
      );

    const offenders: string[] = [];
    for (const path of paths) {
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      if (/get\s+in\s+touch/i.test(code)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
