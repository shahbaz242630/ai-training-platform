import { describe, it, expect } from "vitest";
import {
  assertTransition,
  isTransitionAllowed,
  InvalidTransitionError,
  type TransitionTable,
} from "./transitions";

type Light = "red" | "green" | "off";

const TABLE: TransitionTable<Light> = {
  red: ["green"],
  green: ["red"],
  off: [],
};

describe("isTransitionAllowed", () => {
  it("allows a move the table permits", () => {
    expect(isTransitionAllowed(TABLE, "red", "green")).toBe(true);
  });

  it("refuses a move the table does not permit", () => {
    expect(isTransitionAllowed(TABLE, "red", "off")).toBe(false);
  });

  it("treats staying put as allowed, because a repeated event is not an error", () => {
    expect(isTransitionAllowed(TABLE, "off", "off")).toBe(true);
  });
});

describe("assertTransition", () => {
  it("reports that a permitted move needs writing", () => {
    expect(assertTransition("Light", TABLE, "red", "green")).toBe(true);
  });

  it("reports that a repeat of the current state needs no write", () => {
    expect(assertTransition("Light", TABLE, "green", "green")).toBe(false);
  });

  it("throws on a move the table does not permit", () => {
    expect(() => assertTransition("Light", TABLE, "off", "green")).toThrow(InvalidTransitionError);
  });

  it("names the entity and both states, so a log line is actionable", () => {
    try {
      assertTransition("Light", TABLE, "off", "green");
      expect.unreachable("should have thrown");
    } catch (error) {
      const invalid = error as InvalidTransitionError;
      expect(invalid.entity).toBe("Light");
      expect(invalid.from).toBe("off");
      expect(invalid.to).toBe("green");
      expect(invalid.message).toContain("Light");
      expect(invalid.name).toBe("InvalidTransitionError");
    }
  });
});
