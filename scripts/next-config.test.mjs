import { describe, it, expect } from "vitest";
import { scriptSrcFor } from "../next.config.mjs";

/*
  React's development build uses eval() for debugging features, and our policy
  refuses it - which fills the console with an error and costs the tooling it
  powers. So development allows it and production must never.

  Allowing eval is most of the point of having a script-src at all, so this is
  asserted rather than left to a comment and a careful reader.
*/
describe("scriptSrcFor", () => {
  it("allows eval in development, where React needs it", () => {
    expect(scriptSrcFor("development")).toContain("'unsafe-eval'");
  });

  it("NEVER allows eval in production", () => {
    expect(scriptSrcFor("production")).not.toContain("'unsafe-eval'");
  });

  // An unset or unexpected NODE_ENV must land on the SAFE side, not the
  // convenient one - a build that forgets to declare itself is not a dev build.
  it("refuses eval for anything that is not explicitly development", () => {
    for (const value of ["test", "staging", "", undefined, "Development", "dev"]) {
      expect(scriptSrcFor(value)).not.toContain("'unsafe-eval'");
    }
  });

  it("keeps the rest of the policy identical in both cases", () => {
    expect(scriptSrcFor("production")).toBe("script-src 'self' 'unsafe-inline'");
    expect(scriptSrcFor("development")).toBe("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  });
});
