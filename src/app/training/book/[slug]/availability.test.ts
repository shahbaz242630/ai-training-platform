import { describe, it, expect } from "vitest";
import { stillBookable } from "./availability";
import { AVAILABILITY } from "@/config/availability";

/*
  The booking page serves availability from a short cache (a flood of views
  must not throttle the calendar). A cached list is re-checked against the
  clock on every read, so a time that has come inside the minimum notice since
  the list was loaded is never offered.
*/
describe("stillBookable", () => {
  const now = new Date("2031-03-03T10:00:00Z");
  const noticeMs = AVAILABILITY.minimumNoticeHours * 60 * 60_000;
  const slotAt = (msFromNow: number) => ({
    start: new Date(now.getTime() + msFromNow),
    end: new Date(now.getTime() + msFromNow + 60 * 60_000),
  });

  it("keeps a time that is still far enough ahead", () => {
    const slot = slotAt(noticeMs + 60_000);
    expect(stillBookable([slot], now)).toEqual([slot]);
  });

  it("keeps a time exactly at the minimum notice", () => {
    const slot = slotAt(noticeMs);
    expect(stillBookable([slot], now)).toEqual([slot]);
  });

  it("drops a time that has come inside the minimum notice", () => {
    expect(stillBookable([slotAt(noticeMs - 1)], now)).toEqual([]);
  });

  it("drops a time that has already started", () => {
    expect(stillBookable([slotAt(-60_000)], now)).toEqual([]);
  });
});
