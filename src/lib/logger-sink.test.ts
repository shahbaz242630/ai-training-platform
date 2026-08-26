import { describe, it, expect, afterEach, vi } from "vitest";
import { logger, resetLogSink } from "./logger";

/**
 * The default console sink is what runs in production, so its routing is worth
 * asserting: an error that quietly goes to stdout is an error nobody pages on.
 */
afterEach(() => {
  resetLogSink();
  vi.restoreAllMocks();
});

describe("default console sink", () => {
  it("routes each level to the right console channel", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.error("bad");
    logger.warn("hmm");
    logger.info("fine");
    logger.debug("detail");

    expect(error).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("writes valid JSON lines so aggregators can parse them", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("booking confirmed", { bookingId: "b1" });

    const line = log.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("booking confirmed");
    expect(parsed.context.bookingId).toBe("b1");
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("never interpolates caller input into a format string", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("%s %d injection attempt", { value: "%s" });
    // One argument only - console formatting cannot be hijacked by the message.
    expect(log.mock.calls[0]).toHaveLength(1);
  });
});
