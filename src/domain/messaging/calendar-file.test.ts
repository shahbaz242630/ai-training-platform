import { describe, expect, it } from "vitest";
import { buildCalendarFile, type CalendarFileInput } from "./calendar-file";

const INPUT: CalendarFileInput = {
  uid: "booking-1234abcd@zaaheen.com",
  sequence: 0,
  start: new Date("2026-09-10T15:00:00.000Z"),
  end: new Date("2026-09-10T16:30:00.000Z"),
  stamp: new Date("2026-09-08T09:05:07.000Z"),
  summary: "AI for your daily work (Zaaheen coaching)",
  description: "Your private session.\nJoin on Microsoft Teams: https://teams.example/join",
  url: "https://teams.example/join",
};

const lines = (file: string) => file.split("\r\n");

describe("buildCalendarFile", () => {
  it("is a published event, not an invitation: no organiser, no attendee", () => {
    const file = buildCalendarFile(INPUT);
    expect(file).toContain("METHOD:PUBLISH");
    expect(file).not.toMatch(/ORGANIZER|ATTENDEE|METHOD:REQUEST/);
  });

  it("separates every line with CRLF and ends with one", () => {
    const file = buildCalendarFile(INPUT);
    expect(file.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(file.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes every time in UTC", () => {
    const file = lines(buildCalendarFile(INPUT));
    expect(file).toContain("DTSTART:20260910T150000Z");
    expect(file).toContain("DTEND:20260910T163000Z");
    expect(file).toContain("DTSTAMP:20260908T090507Z");
  });

  it("carries a stable id and a sequence, so a later version replaces this one", () => {
    const file = lines(buildCalendarFile({ ...INPUT, sequence: 1 }));
    expect(file).toContain("UID:booking-1234abcd@zaaheen.com");
    expect(file).toContain("SEQUENCE:1");
  });

  it("escapes the characters the format reserves in text", () => {
    const file = buildCalendarFile({
      ...INPUT,
      summary: "Prompts, agents; and a back\\slash",
      description: "Line one\nLine two",
    });
    const unfolded = file.replace(/\r\n /g, "");
    expect(unfolded).toContain("SUMMARY:Prompts\\, agents\\; and a back\\\\slash");
    expect(unfolded).toContain("DESCRIPTION:Line one\\nLine two");
  });

  it("folds long lines at 75 bytes without splitting a character", () => {
    const file = buildCalendarFile({ ...INPUT, description: "é".repeat(120) });
    const encoder = new TextEncoder();
    for (const line of lines(file)) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    const unfolded = file.replace(/\r\n /g, "");
    expect(unfolded).toContain(`DESCRIPTION:${"é".repeat(120)}`);
  });

  it("puts the join link where calendars show it, and a reminder before the start", () => {
    const unfolded = buildCalendarFile(INPUT).replace(/\r\n /g, "");
    expect(unfolded).toContain("URL:https://teams.example/join");
    expect(unfolded).toContain("LOCATION:Microsoft Teams");
    expect(unfolded).toContain("TRIGGER:-PT15M");
  });
});
