import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadCalendarEventsFromIcs } from "../src/adapters/calendar/ics-calendar.js";

test("ics loader parses vevents and maps course names", async () => {
  const fixture = path.join(process.cwd(), "tests", "fixtures", "sample.ics");
  const events = await loadCalendarEventsFromIcs(fixture);

  assert.equal(events.length, 2);
  assert.equal(events[0]?.courseName, "Descriptive Statistics & Probability");
  assert.equal(events[0]?.date, "2026-03-02");
  assert.equal(events[1]?.courseName, "Business Law II (sections C, D E & F)");
  assert.equal(events[1]?.date, "2026-03-03");
});
