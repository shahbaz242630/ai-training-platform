import { describe, it, expect } from "vitest";
import {
  checkActionsPinned,
  checkPublicEnvSecrets,
  checkNoRawHtmlInjection,
  checkNoDynamicCodeExecution,
  checkPricesCentralised,
  checkEnvCentralised,
  checkNoInsecureUrls,
  checkNoTrackedEnvFiles,
  checkRuntimesSingleSourced,
} from "./security-check.mjs";

const file = (path, content) => [{ path, content }];

// Assembled rather than written literally, for the same reason as in the guard
// itself: a fixture containing the real token would trip the pipeline scanners.
const RAW_HTML = "dangerously" + "SetInnerHTML";
const CODE_EVAL = "ev" + "al";
const FN_CTOR = "new " + "Func" + "tion('x')";

describe("checkActionsPinned", () => {
  it("accepts a 40-character commit SHA", () => {
    const yaml = "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7";
    expect(checkActionsPinned(file(".github/workflows/ci.yml", yaml))).toEqual([]);
  });

  it("rejects a mutable tag", () => {
    expect(checkActionsPinned(file("w.yml", "  - uses: actions/checkout@v4"))).toHaveLength(1);
  });

  it("rejects a branch reference", () => {
    expect(checkActionsPinned(file("w.yml", "  - uses: some/action@main"))).toHaveLength(1);
  });

  it("ignores local composite actions", () => {
    expect(checkActionsPinned(file("w.yml", "  - uses: ./.github/actions/setup"))).toEqual([]);
  });
});

describe("checkPublicEnvSecrets", () => {
  it("flags a secret exposed to the browser", () => {
    expect(checkPublicEnvSecrets(file("a.ts", "NEXT_PUBLIC_STRIPE_SECRET_KEY"))).toHaveLength(1);
    expect(checkPublicEnvSecrets(file("a.ts", "NEXT_PUBLIC_SERVICE_ROLE_KEY"))).toHaveLength(1);
  });

  it("allows keys that are public by design", () => {
    expect(checkPublicEnvSecrets(file("a.ts", "NEXT_PUBLIC_SUPABASE_ANON_KEY"))).toEqual([]);
    expect(checkPublicEnvSecrets(file("a.ts", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"))).toEqual([]);
  });

  it("allows an ordinary public value", () => {
    expect(checkPublicEnvSecrets(file("a.ts", "NEXT_PUBLIC_SITE_URL"))).toEqual([]);
  });
});

describe("checkNoRawHtmlInjection", () => {
  it("flags raw HTML injection", () => {
    expect(checkNoRawHtmlInjection(file("a.tsx", `<div ${RAW_HTML}={x} />`))).toHaveLength(1);
  });

  it("passes ordinary markup", () => {
    expect(checkNoRawHtmlInjection(file("a.tsx", "<div>hello</div>"))).toEqual([]);
  });
});

describe("checkNoDynamicCodeExecution", () => {
  it("flags dynamic evaluation and the constructor form", () => {
    expect(checkNoDynamicCodeExecution(file("a.ts", CODE_EVAL + "('x')"))).toHaveLength(1);
    expect(checkNoDynamicCodeExecution(file("a.ts", FN_CTOR))).toHaveLength(1);
  });

  it("does not flag an identifier that merely contains the token", () => {
    expect(checkNoDynamicCodeExecution(file("a.ts", "const retri" + "eval = 1;"))).toEqual([]);
  });
});

describe("checkPricesCentralised", () => {
  it("allows price construction inside the catalogue", () => {
    expect(checkPricesCentralised(file("src/config/sessions.ts", "aedToFils(1299)"))).toEqual([]);
  });

  it("allows the module that defines the helper", () => {
    // money.ts declares aedToFils; declaring it is not building a price.
    expect(
      checkPricesCentralised(file("src/lib/money.ts", "export function aedToFils(aed) {}")),
    ).toEqual([]);
  });

  it("flags a price built anywhere else", () => {
    expect(checkPricesCentralised(file("src/app/page.tsx", "aedToFils(999)"))).toHaveLength(1);
  });
});

describe("checkEnvCentralised", () => {
  it("allows the validated env module itself", () => {
    expect(checkEnvCentralised(file("src/lib/env.ts", "process.env.NODE_ENV"))).toEqual([]);
  });

  it("flags direct access elsewhere", () => {
    expect(checkEnvCentralised(file("src/app/x.ts", "process.env.STRIPE_SECRET_KEY"))).toHaveLength(
      1,
    );
  });
});

describe("checkNoInsecureUrls", () => {
  it("allows localhost", () => {
    expect(checkNoInsecureUrls(file("a.ts", "http://localhost:3000"))).toEqual([]);
  });

  it("flags a remote cleartext URL", () => {
    expect(checkNoInsecureUrls(file("a.ts", "http://api.example.com"))).toHaveLength(1);
  });
});

describe("checkNoTrackedEnvFiles", () => {
  it("allows the template", () => {
    expect(checkNoTrackedEnvFiles([".env.example"])).toEqual([]);
  });

  it("flags a tracked environment file", () => {
    expect(checkNoTrackedEnvFiles([".env.local"])).toHaveLength(1);
    expect(checkNoTrackedEnvFiles(["apps/web/.env.production"])).toHaveLength(1);
  });
});

describe("checkRuntimesSingleSourced", () => {
  const setupNode = (line) =>
    file(
      ".github/workflows/ci.yml",
      ["      - uses: actions/setup-node@abc", "        with:", line].join("\n"),
    );

  it("accepts the Node version being read from .nvmrc", () => {
    expect(checkRuntimesSingleSourced(setupNode("          node-version-file: .nvmrc"))).toEqual(
      [],
    );
  });

  it("rejects a hardcoded Node version", () => {
    expect(checkRuntimesSingleSourced(setupNode('          node-version: "24"'))).toHaveLength(1);
  });

  it("rejects a NODE_VERSION workflow variable", () => {
    expect(checkRuntimesSingleSourced(file("w.yml", 'env:\n  NODE_VERSION: "24"'))).toHaveLength(1);
  });

  it("rejects pnpm pinned in the workflow instead of package.json", () => {
    const yaml = [
      "      - uses: pnpm/action-setup@abc",
      "        with:",
      "          version: 11.24.0",
    ].join("\n");
    expect(checkRuntimesSingleSourced(file("w.yml", yaml))).toHaveLength(1);
  });

  it("leaves a version input belonging to some other action alone", () => {
    const yaml = [
      "      - uses: some/other-action@abc",
      "        with:",
      "          version: 3.1.0",
    ].join("\n");
    expect(checkRuntimesSingleSourced(file("w.yml", yaml))).toEqual([]);
  });

  it("reports the offending line number", () => {
    const yaml = ["jobs:", "  a:", "    steps:", '      - node-version: "22"'].join("\n");
    expect(checkRuntimesSingleSourced(file("w.yml", yaml))[0]).toContain("w.yml:4");
  });
});

describe("checkEnvCentralised", () => {
  it("allows env.ts and its own test to touch process.env", () => {
    expect(checkEnvCentralised(file("src/lib/env.ts", "process.env.FOO"))).toEqual([]);
    expect(checkEnvCentralised(file("src/lib/env.test.ts", "process.env.FOO = 'x'"))).toEqual([]);
  });

  // The exception must stay exactly two files wide. A test elsewhere reaching
  // for process.env directly is how the single source of truth quietly stops
  // being one.
  it("still flags every other file, tests included", () => {
    expect(checkEnvCentralised(file("src/lib/other.ts", "process.env.FOO"))).toHaveLength(1);
    expect(checkEnvCentralised(file("src/domain/thing.test.ts", "process.env.FOO"))).toHaveLength(
      1,
    );
    expect(checkEnvCentralised(file("src/lib/envelope.ts", "process.env.FOO"))).toHaveLength(1);
  });
});
