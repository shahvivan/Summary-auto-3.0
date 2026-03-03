import "dotenv/config";
import { config } from "../config.js";
import { executeRun } from "../core/orchestrator/pipeline.js";
import { loadScheduleEvents, toSession } from "../core/scheduler/engine.js";
import { initStorage, upsertSession } from "../storage/sqlite.js";
import type { SessionOverride, SummaryProviderMode } from "../types/domain.js";
import { logError, logInfo } from "../utils/logger.js";
import { parseCliArgs } from "./args.js";

async function main(): Promise<void> {
  await initStorage();
  logInfo(
    `Providers configured: gemini=${config.geminiEnabled}, chatpdf=${config.chatpdfEnabled}, deterministic=${config.deterministicEnabled}`,
  );

  const args = parseCliArgs(process.argv.slice(2));
  const from = (args.from as string | undefined) ?? "0000-01-01";
  const to = (args.to as string | undefined) ?? "9999-12-31";

  const override: SessionOverride = {
    sectionId: (args.sectionId as string | undefined) ?? undefined,
    topicNumber: args.topic ? Number(args.topic) : undefined,
    contains: (args.contains as string | undefined) ?? undefined,
    persistAsAnchor: false,
  };
  const provider = (args.provider as SummaryProviderMode | undefined) ?? undefined;
  const moodleDebug = args["moodle-debug"] ? String(args["moodle-debug"]) !== "false" : false;
  const requireAuth = args["require-auth"] ? String(args["require-auth"]) !== "false" : true;

  const events = (await loadScheduleEvents()).filter((event) => event.date >= from && event.date <= to);
  if (events.length === 0) {
    logInfo("No events found in selected range", { from, to });
    return;
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
      logInfo("Backtest session done", {
        runId,
        date: session.date,
        course: session.courseName,
        sessionId: session.sessionId,
      });
    } catch (error) {
      failures += 1;
      logError(`Backtest failed for ${session.sessionId}`, error);
    }
  }

  logInfo("Backtest finished", { total: events.length, failed: failures });
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
