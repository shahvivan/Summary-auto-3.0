import { config } from "../config.js";
import { executeRun } from "../core/orchestrator/pipeline.js";
import { createManualSession, getEventsForDate, toSession } from "../core/scheduler/engine.js";
import { initStorage, upsertSession } from "../storage/sqlite.js";
import type { SessionOverride, SummaryProviderMode } from "../types/domain.js";
import { logError, logInfo } from "../utils/logger.js";
import { parseCliArgs } from "./args.js";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  await initStorage();

  const args = parseCliArgs(process.argv.slice(2));
  const date = (args.date as string | undefined) ?? todayIso();

  const override: SessionOverride = {
    sectionId: (args.sectionId as string | undefined) ?? undefined,
    topicNumber: args.topic ? Number(args.topic) : undefined,
    contains: (args.contains as string | undefined) ?? undefined,
    persistAsAnchor: args.persistAnchor ? String(args.persistAnchor) !== "false" : true,
  };
  const provider = (args.provider as SummaryProviderMode | undefined) ?? undefined;
  const moodleDebug = args["moodle-debug"] ? String(args["moodle-debug"]) !== "false" : false;
  const requireAuth = args["require-auth"] ? String(args["require-auth"]) !== "false" : true;

  if (args.course) {
    const session = createManualSession({
      courseName: String(args.course),
      date,
      eventTitle: (args.eventTitle as string | undefined) ?? undefined,
      sessionLabel: (args.sessionLabel as string | undefined) ?? undefined,
    });

    upsertSession(session);
    try {
      const runId = await executeRun(session, override, undefined, {
        provider,
        moodleDebug,
        requireAuth,
      });
      logInfo(`Manual run completed`, { runId, sessionId: session.sessionId, course: session.courseName });
      return;
    } catch (error) {
      logError("Manual run failed", error);
      process.exitCode = 1;
      return;
    }
  }

  let events;
  try {
    events = await getEventsForDate(date);
  } catch (error) {
    logError("Failed to load calendar events", error);
    process.exitCode = 1;
    return;
  }

  if (events.length === 0) {
    const source = config.calendarUseIcs ? "ICS" : "MOCK";
    logInfo(`No events found for date (${source} source)`, { date });
  }

  let failures = 0;

  for (const event of events) {
    const session = toSession(event);
    upsertSession(session);

    try {
      const runId = await executeRun(session, override, undefined, {
        provider,
        moodleDebug,
        requireAuth,
      });
      logInfo(`Autopilot session completed`, { runId, sessionId: session.sessionId, course: session.courseName });
    } catch (error) {
      failures += 1;
      logError(`Autopilot session failed for ${session.courseName}`, error);
    }
  }

  logInfo(`Autopilot finished`, { date, total: events.length, failed: failures });
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
