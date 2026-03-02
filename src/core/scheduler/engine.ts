import { loadCalendarEventsFromIcs } from "../../adapters/calendar/ics-calendar.js";
import { loadCalendarEvents } from "../../adapters/calendar/mock-calendar.js";
import { config } from "../../config.js";
import type { ScheduleEvent, Session } from "../../types/domain.js";
import { logInfo, logWarn } from "../../utils/logger.js";
import { normalizeCourseKey, slugify } from "../../utils/text.js";

interface CalendarLoadSources {
  loadIcs: () => Promise<ScheduleEvent[]>;
  loadMock: () => Promise<ScheduleEvent[]>;
}

export async function loadScheduleEventsWithSources(
  sources: CalendarLoadSources,
  options?: {
    calendarUseIcs?: boolean;
    allowMockFallback?: boolean;
    hasIcsUrl?: boolean;
  },
): Promise<ScheduleEvent[]> {
  const useIcs = options?.calendarUseIcs ?? config.calendarUseIcs;
  const allowMockFallback = options?.allowMockFallback ?? config.allowMockFallback;
  const hasIcsUrl = options?.hasIcsUrl ?? config.calendarIcsUrl.trim().length > 0;

  if (useIcs) {
    if (!hasIcsUrl) {
      throw new Error("Calendar source is ICS but CALENDAR_ICS_URL is missing");
    }

    logInfo("Calendar source: ICS");
    try {
      const events = await sources.loadIcs();
      logInfo(`Calendar events loaded: ${events.length}`);
      return events;
    } catch (error) {
      if (!allowMockFallback) {
        throw error;
      }
      logWarn("ICS failed, falling back to mock because ALLOW_MOCK_FALLBACK=true");
      logInfo("Calendar source: MOCK");
      const mockEvents = await sources.loadMock();
      logInfo(`Calendar events loaded: ${mockEvents.length}`);
      return mockEvents;
    }
  }

  logInfo("Calendar source: MOCK");
  const mockEvents = await sources.loadMock();
  logInfo(`Calendar events loaded: ${mockEvents.length}`);
  return mockEvents;
}

export async function loadScheduleEvents(): Promise<ScheduleEvent[]> {
  return loadScheduleEventsWithSources({
    loadIcs: () => loadCalendarEventsFromIcs(config.calendarIcsUrl),
    loadMock: loadCalendarEvents,
  });
}

export async function getEventsForDate(date: string): Promise<ScheduleEvent[]> {
  const events = await loadScheduleEvents();
  return events.filter((event) => event.date === date);
}

export function toSession(event: ScheduleEvent): Session {
  const courseKey = normalizeCourseKey(event.courseName);
  return {
    sessionId: `${event.date}-${slugify(event.courseName)}-${event.id}`,
    courseName: event.courseName,
    courseKey,
    eventTitle: event.title,
    date: event.date,
    sessionLabel: event.topicLabel,
  };
}

export function createManualSession(input: {
  courseName: string;
  date: string;
  eventTitle?: string;
  sessionLabel?: string;
}): Session {
  const eventTitle = input.eventTitle?.trim() || `${input.courseName} lecture`;
  const syntheticId = `manual-${Date.now()}`;
  const event: ScheduleEvent = {
    id: syntheticId,
    courseName: input.courseName,
    title: eventTitle,
    date: input.date,
    topicLabel: input.sessionLabel,
  };
  return toSession(event);
}
