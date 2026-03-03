import fs from "node:fs/promises";
import { config } from "../../config.js";
import type { ScheduleEvent } from "../../types/domain.js";
import { findCourseMapEntry } from "../../utils/course-map.js";
import { extractTopicNumber, shaLike } from "../../utils/text.js";

interface ParsedVevent {
  uid?: string;
  summary?: string;
  dtstart?: string;
}

function unfoldIcsLines(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]}${line.slice(1)}`;
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseEvents(raw: string): ParsedVevent[] {
  const lines = unfoldIcsLines(raw);
  const events: ParsedVevent[] = [];
  let current: ParsedVevent | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        events.push(current);
      }
      current = null;
      continue;
    }
    if (!current) {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();

    if (key === "UID") {
      current.uid = value;
    } else if (key === "SUMMARY") {
      current.summary = value;
    } else if (key.startsWith("DTSTART")) {
      current.dtstart = value;
    }
  }

  return events;
}

function yyyymmddToIsoDate(value: string): string {
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  return `${year}-${month}-${day}`;
}

function toIsoDate(dtstart: string): string | null {
  const dateOnly = dtstart.match(/^(\d{8})$/);
  if (dateOnly) {
    return yyyymmddToIsoDate(dateOnly[1]);
  }

  const dateTime = dtstart.match(/^(\d{8})T\d{6}Z?$/);
  if (dateTime) {
    return yyyymmddToIsoDate(dateTime[1]);
  }

  return null;
}

function deriveTopicLabel(summary: string): string | undefined {
  const topicNumber = extractTopicNumber(summary);
  if (topicNumber === null) {
    return undefined;
  }
  return `Topic ${topicNumber}`;
}

async function inferCourseName(summary: string): Promise<string> {
  const match = await findCourseMapEntry(summary);
  if (match) {
    return match.courseName;
  }

  // Strip trailing professor/instructor block — e.g. " [Smith, John]" — before
  // using the rest as the course name so we don't chop at an internal colon.
  const withoutProf = summary.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  if (withoutProf) {
    return withoutProf;
  }

  return summary.trim();
}

async function loadIcsRawText(url: string): Promise<string> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`ICS request failed (${response.status})`);
      }
      return await response.text();
    } catch (error) {
      clearTimeout(timeout);
      // Re-wrap low-level connection errors (ECONNRESET, terminated, etc.)
      // into a clear message so callers get a useful Error, not a raw undici TypeError.
      if (error instanceof Error) {
        const isConnectionError =
          error.message.includes("terminated") ||
          error.message.includes("ECONNRESET") ||
          error.message.includes("ENOTFOUND") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("aborted");
        if (isConnectionError) {
          throw new Error(`ICS fetch connection error (${error.message})`);
        }
        throw error;
      }
      throw new Error(`ICS fetch failed: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return fs.readFile(url, "utf8");
}

export async function loadCalendarEventsFromIcs(icsUrl = config.calendarIcsUrl): Promise<ScheduleEvent[]> {
  if (!icsUrl) {
    return [];
  }

  const raw = await loadIcsRawText(icsUrl);
  const vevents = parseEvents(raw);
  const results: ScheduleEvent[] = [];

  for (let index = 0; index < vevents.length; index += 1) {
    const item = vevents[index];
    if (!item.summary || !item.dtstart) {
      continue;
    }
    const date = toIsoDate(item.dtstart);
    if (!date) {
      continue;
    }

    const courseName = await inferCourseName(item.summary);
    results.push({
      // Hash the long ICS UID to a short 8-char hex so session IDs stay readable.
      id: item.uid ? shaLike(item.uid) : `ics-${index + 1}`,
      courseName,
      title: item.summary,
      date,
      topicLabel: deriveTopicLabel(item.summary),
    });
  }

  return results;
}
