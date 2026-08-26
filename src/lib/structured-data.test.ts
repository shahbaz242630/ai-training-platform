import { describe, it, expect } from "vitest";
import { buildTrainingJsonLd } from "./structured-data";
import { SITE, type SitePlaceholders } from "@/config/site";
import { getActiveSessions } from "@/config/sessions";
import { filsToAed } from "@/lib/money";

/**
 * This code decides what we publish about ourselves to search and answer
 * engines. It is the difference between being described accurately and being
 * cached inaccurately for months, so it is tested against a fully configured
 * identity rather than only in its (current) suppressed state.
 */
const CONFIGURED: SitePlaceholders = {
  ...SITE,
  companyName: "Example Company",
  legalEntityName: "Example Company FZ-LLC",
  domain: "example.ae",
};

describe("buildTrainingJsonLd", () => {
  it("emits nothing while identity is unset", () => {
    expect(buildTrainingJsonLd(SITE)).toBeNull();
  });

  it("emits nothing when any required identity field is missing", () => {
    expect(buildTrainingJsonLd({ ...CONFIGURED, domain: null })).toBeNull();
    expect(buildTrainingJsonLd({ ...CONFIGURED, companyName: null })).toBeNull();
    expect(buildTrainingJsonLd({ ...CONFIGURED, legalEntityName: null })).toBeNull();
  });

  it("produces valid JSON with an Organization and one Service per session", () => {
    const graph = JSON.parse(buildTrainingJsonLd(CONFIGURED)!);

    expect(graph["@context"]).toBe("https://schema.org");
    const organizations = graph["@graph"].filter(
      (n: { "@type": string }) => n["@type"] === "Organization",
    );
    const services = graph["@graph"].filter((n: { "@type": string }) => n["@type"] === "Service");

    expect(organizations).toHaveLength(1);
    expect(organizations[0].name).toBe("Example Company");
    expect(organizations[0].legalName).toBe("Example Company FZ-LLC");
    expect(services).toHaveLength(getActiveSessions().length);
  });

  it("quotes prices that match the catalogue exactly", () => {
    const graph = JSON.parse(buildTrainingJsonLd(CONFIGURED)!);
    const services = graph["@graph"].filter((n: { "@type": string }) => n["@type"] === "Service");

    for (const session of getActiveSessions()) {
      const service = services.find((s: { name: string }) => s.name === session.title);
      expect(service, session.code).toBeDefined();
      expect(service.offers.price).toBe(filsToAed(session.priceFils).toFixed(2));
      expect(service.offers.priceCurrency).toBe("AED");
    }
  });

  it("never manufactures ratings or reviews", () => {
    // PRD §18.3 forbids review schema we cannot substantiate. Fabricated
    // aggregate ratings are exactly the fake-credibility signal the BRD bans.
    const json = buildTrainingJsonLd(CONFIGURED)!;
    expect(json).not.toMatch(/aggregateRating|reviewCount|ratingValue|Review/i);
  });

  it("uses https and links services back to the organization node", () => {
    const graph = JSON.parse(buildTrainingJsonLd(CONFIGURED)!);
    const organizationId = graph["@graph"][0]["@id"];
    expect(organizationId).toMatch(/^https:\/\//);

    for (const node of graph["@graph"].slice(1)) {
      expect(node.provider["@id"]).toBe(organizationId);
      expect(node.offers.url).toMatch(/^https:\/\/example\.ae\/training#/);
    }
  });

  it("carries no placeholder tokens into published output", () => {
    expect(buildTrainingJsonLd(CONFIGURED)!).not.toMatch(/\[[A-Z_]+\]/);
  });
});
