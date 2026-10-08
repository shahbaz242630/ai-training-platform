import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { embedTermsPdf, termsPdfModule } from "./embed-terms-pdf.mjs";

const PDF = Buffer.from("%PDF-1.4\nbody\n%%EOF");

let dir = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("termsPdfModule", () => {
  it("exports the PDF as base64 under a name for its version", () => {
    const text = termsPdfModule("2026-10-08", PDF);
    expect(text).toContain("export const TERMS_PDF_2026_10_08 =");
    expect(text).toContain(`"${PDF.toString("base64")}"`);
  });

  it("refuses a version that is not a date, and a file that is not a PDF", () => {
    expect(() => termsPdfModule("latest", PDF)).toThrow(/YYYY-MM-DD/);
    expect(() => termsPdfModule("2026-10-08", Buffer.from("hello"))).toThrow(/not a PDF/);
  });
});

describe("embedTermsPdf", () => {
  it("writes the module into src/legal under the given root", () => {
    dir = mkdtempSync(join(tmpdir(), "terms-pdf-"));
    mkdirSync(join(dir, "src", "legal"), { recursive: true });
    const pdfPath = join(dir, "terms.pdf");
    writeFileSync(pdfPath, PDF);

    const out = embedTermsPdf({ version: "2026-10-08", pdfPath, root: dir });

    expect(out).toBe(join(dir, "src", "legal", "terms-2026-10-08.generated.ts"));
    expect(readFileSync(out, "utf8")).toContain(PDF.toString("base64"));
  });
});
