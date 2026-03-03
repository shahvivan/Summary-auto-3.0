import assert from "node:assert/strict";
import test from "node:test";
import { loadScheduleEventsWithSources } from "../src/core/scheduler/engine.js";
import type { ScheduleEvent } from "../src/types/domain.js";

function sampleEvent(id: string): ScheduleEvent {
  return {
    id,
    courseName: "Descriptive Statistics & Probability",
    title: "Topic 3",
    date: "2026-03-02",
  };
}

test("scheduler uses ICS only when CALENDAR_USE_ICS=true", async () => {
  let icsCalls = 0;
  let mockCalls = 0;

  const events = await loadScheduleEventsWithSources(
    {
      loadIcs: async () => {
        icsCalls += 1;
        return [sampleEvent("ics-1")];
      },
      loadMock: async () => {
        mockCalls += 1;
        return [sampleEvent("mock-1")];
      },
    },
    {
      calendarUseIcs: true,
      allowMockFallback: false,
      hasIcsUrl: true,
    },
  );

  assert.equal(icsCalls, 1);
  assert.equal(mockCalls, 0);
  assert.equal(events[0]?.id, "ics-1");
});

test("scheduler does not silently fallback from ICS to MOCK when fallback is disabled", async () => {
  let mockCalls = 0;

  await assert.rejects(
    () =>
      loadScheduleEventsWithSources(
        {
          loadIcs: async () => {
            throw new Error("ICS broken");
          },
          loadMock: async () => {
            mockCalls += 1;
            return [sampleEvent("mock-1")];
          },
        },
        {
          calendarUseIcs: true,
          allowMockFallback: false,
          hasIcsUrl: true,
        },
      ),
    /ICS broken/,
  );

  assert.equal(mockCalls, 0);
});

test("scheduler can fallback to mock only when ALLOW_MOCK_FALLBACK=true", async () => {
  let mockCalls = 0;

  const events = await loadScheduleEventsWithSources(
    {
      loadIcs: async () => {
        throw new Error("ICS broken");
      },
      loadMock: async () => {
        mockCalls += 1;
        return [sampleEvent("mock-1")];
      },
    },
    {
      calendarUseIcs: true,
      allowMockFallback: true,
      hasIcsUrl: true,
    },
  );

  assert.equal(mockCalls, 1);
  assert.equal(events[0]?.id, "mock-1");
});
