import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIn } from "./heartbeat";
import { resetLogSink, setLogSink } from "./logger";

/**
 * Checking in with the outside monitor. "ok" and "fail" go to different
 * addresses, the body names what is wrong and nothing else, and the monitor
 * being down never makes the sweep fail.
 */

const URL = "https://hc-ping.example/abc-123";

interface Call {
  readonly url: string;
  readonly body: string;
}

function recorder(response: Response | Error) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

beforeEach(() => setLogSink(() => undefined));
afterEach(() => resetLogSink());

describe("checkIn", () => {
  it("does nothing at all when no monitor is set", async () => {
    const { calls, fetchImpl } = recorder(new Response("OK"));
    expect(await checkIn(undefined, [], fetchImpl)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("says all is well at the address itself", async () => {
    const { calls, fetchImpl } = recorder(new Response("OK"));
    expect(await checkIn(URL, [], fetchImpl)).toEqual({ sent: true, outcome: "ok" });
    expect(calls).toEqual([{ url: URL, body: "" }]);
  });

  it("reports a problem at the fail address, naming what is wrong", async () => {
    const { calls, fetchImpl } = recorder(new Response("OK"));
    const result = await checkIn(`${URL}/`, ["schema_behind", "refunds_overdue"], fetchImpl);
    expect(result).toEqual({ sent: true, outcome: "fail" });
    expect(calls).toEqual([{ url: `${URL}/fail`, body: "schema_behind, refunds_overdue" }]);
  });

  it("never throws when the monitor refuses or cannot be reached", async () => {
    const refused = recorder(new Response("nope", { status: 404 }));
    expect(await checkIn(URL, [], refused.fetchImpl)).toEqual({ sent: false, outcome: "ok" });

    const down = recorder(new Error("ECONNREFUSED"));
    expect(await checkIn(URL, ["sweep_failed"], down.fetchImpl)).toEqual({
      sent: false,
      outcome: "fail",
    });
  });
});
