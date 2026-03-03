import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { Router } from "express";
import { z } from "zod";
import { executeRun, queueRun } from "../core/orchestrator/pipeline.js";
import { createManualSession, getEventsForDate, toSession } from "../core/scheduler/engine.js";
import {
  getResolverDebug,
  getRun,
  getSession,
  getSessionDetail,
  listLatestRuns,
  listSessionsForDate,
  upsertSession,
} from "../storage/sqlite.js";
import type { SessionOverride, SummaryProviderMode } from "../types/domain.js";
import { logInfo, logWarn } from "../utils/logger.js";

const providerEnum = z.enum(["auto", "gemini", "chatpdf", "deterministic"]);

const autopilotSchema = z.object({
  date: z.string().optional(),
  provider: providerEnum.optional(),
  moodleDebug: z.boolean().optional(),
  requireAuth: z.boolean().optional(),
});

const prepareSchema = z.object({
  courseName: z.string().min(1),
  date: z.string(),
  eventTitle: z.string().optional(),
  sessionLabel: z.string().optional(),
  provider: providerEnum.optional(),
  moodleDebug: z.boolean().optional(),
  requireAuth: z.boolean().optional(),
  override: z
    .object({
      sectionId: z.string().optional(),
      topicNumber: z.number().int().positive().optional(),
      contains: z.string().optional(),
      persistAsAnchor: z.boolean().optional(),
    })
    .optional(),
  sync: z.boolean().optional(),
});

const overrideSchema = z.object({
  sectionId: z.string().optional(),
  topicNumber: z.number().int().positive().optional(),
  contains: z.string().optional(),
  persistAnchor: z.boolean().optional(),
  provider: providerEnum.optional(),
  moodleDebug: z.boolean().optional(),
  requireAuth: z.boolean().optional(),
  sync: z.boolean().optional(),
});

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function toError(message: string, errorCode = "internal_error"): { ok: false; errorCode: string; message: string } {
  return { ok: false, errorCode, message };
}

async function runAutopilotToday(payload: {
  date?: string;
  provider?: SummaryProviderMode;
  moodleDebug?: boolean;
  requireAuth?: boolean;
}) {
  const date = payload.date ?? todayIso();
  const events = await getEventsForDate(date);
  const source = config.calendarUseIcs ? "ICS" : "MOCK";
  logInfo(`Autopilot calendar events for ${date}: ${events.length} (${source})`);
  if (events.length === 0) {
    logInfo(`No sessions queued because ${source} source returned 0 events`, { date });
  }

  const batchRunId = randomUUID();

  const sessionStates: Array<{ sessionId: string; status: string; runId: string }> = [];
  for (const event of events) {
    const session = toSession(event);
    upsertSession(session);
    const { runId } = queueRun(session, undefined, {
      provider: payload.provider,
      moodleDebug: payload.moodleDebug,
      requireAuth: payload.requireAuth,
    });
    sessionStates.push({ sessionId: session.sessionId, status: "queued", runId });
  }

  return { batchRunId, date, sessions: sessionStates };
}

export function createApiRouter(): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  router.get("/config-status", (_req, res) => {
    res.json({
      ok: true,
      providers: {
        geminiEnabled: config.geminiEnabled,
        chatpdfEnabled: config.chatpdfEnabled,
        deterministicEnabled: config.deterministicEnabled,
        chatpdfMissingSourceId:
          config.chatpdfApiKey.trim().length > 0 && config.chatpdfSourceId.trim().length === 0,
      },
      calendar: {
        source: config.calendarUseIcs ? "ICS" : "MOCK",
        allowMockFallback: config.allowMockFallback,
      },
    });
  });

  router.get("/today", async (req, res) => {
    const date = (req.query.date as string | undefined) ?? todayIso();
    try {
      const events = await getEventsForDate(date);
      for (const event of events) {
        upsertSession(toSession(event));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Calendar load failed";
      logWarn(`/api/today: calendar events could not be loaded (${message}) — returning persisted sessions only`);
    }

    const sessions = listSessionsForDate(date);
    const runs = listLatestRuns(50);
    res.json({ ok: true, date, sessions, runs });
  });

  router.post("/autopilot/today", async (req, res) => {
    const parsed = autopilotSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(toError("Invalid payload", "validation_error"));
    }

    try {
      const out = await runAutopilotToday({
        date: parsed.data.date,
        provider: parsed.data.provider,
        moodleDebug: parsed.data.moodleDebug,
        requireAuth: parsed.data.requireAuth,
      });
      return res.json({ ok: true, runId: out.batchRunId, sessions: out.sessions, date: out.date });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Autopilot failed";
      return res.status(500).json(toError(message));
    }
  });

  // Backward-compatible aliases for external integrations.
  router.post("/run-today", async (req, res) => {
    const parsed = autopilotSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(toError("Invalid payload", "validation_error"));
    }
    try {
      const out = await runAutopilotToday({
        date: parsed.data.date,
        provider: parsed.data.provider,
        moodleDebug: parsed.data.moodleDebug,
        requireAuth: parsed.data.requireAuth,
      });
      return res.json({ ok: true, runId: out.batchRunId, sessions: out.sessions, date: out.date });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Autopilot failed";
      return res.status(500).json(toError(message));
    }
  });

  router.post("/session/prepare", async (req, res) => {
    const parsed = prepareSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(toError("Invalid payload", "validation_error"));
    }

    try {
      const session = createManualSession({
        courseName: parsed.data.courseName,
        date: parsed.data.date,
        eventTitle: parsed.data.eventTitle,
        sessionLabel: parsed.data.sessionLabel,
      });
      upsertSession(session);

      if (parsed.data.sync) {
        const runId = await executeRun(session, parsed.data.override as SessionOverride | undefined, undefined, {
          provider: parsed.data.provider,
          moodleDebug: parsed.data.moodleDebug,
          requireAuth: parsed.data.requireAuth,
        });
        return res.json({ ok: true, runId, sessionId: session.sessionId });
      }

      const { runId } = queueRun(session, parsed.data.override as SessionOverride | undefined, {
        provider: parsed.data.provider,
        moodleDebug: parsed.data.moodleDebug,
        requireAuth: parsed.data.requireAuth,
      });
      return res.json({ ok: true, runId, sessionId: session.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prepare failed";
      return res.status(500).json(toError(message));
    }
  });

  router.post("/run-session", async (req, res) => {
    const parsed = prepareSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(toError("Invalid payload", "validation_error"));
    }

    try {
      const session = createManualSession({
        courseName: parsed.data.courseName,
        date: parsed.data.date,
        eventTitle: parsed.data.eventTitle,
        sessionLabel: parsed.data.sessionLabel,
      });
      upsertSession(session);

      if (parsed.data.sync) {
        const runId = await executeRun(session, parsed.data.override as SessionOverride | undefined, undefined, {
          provider: parsed.data.provider,
          moodleDebug: parsed.data.moodleDebug,
          requireAuth: parsed.data.requireAuth,
        });
        return res.json({ ok: true, runId, sessionId: session.sessionId });
      }

      const { runId } = queueRun(session, parsed.data.override as SessionOverride | undefined, {
        provider: parsed.data.provider,
        moodleDebug: parsed.data.moodleDebug,
        requireAuth: parsed.data.requireAuth,
      });
      return res.json({ ok: true, runId, sessionId: session.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prepare failed";
      return res.status(500).json(toError(message));
    }
  });

  router.post("/session/:sessionId/override", async (req, res) => {
    const parsed = overrideSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(toError("Invalid override payload", "validation_error"));
    }

    const record = getSession(req.params.sessionId);
    if (!record) {
      return res.status(404).json(toError("Session not found", "not_found"));
    }

    const override: SessionOverride = {
      sectionId: parsed.data.sectionId,
      topicNumber: parsed.data.topicNumber,
      contains: parsed.data.contains,
      persistAsAnchor: parsed.data.persistAnchor ?? true,
    };

    try {
      const session = {
        sessionId: record.sessionId,
        courseName: record.courseName,
        courseKey: record.courseKey,
        eventTitle: record.eventTitle,
        date: record.date,
        sessionLabel: record.sessionLabel,
      };

      if (parsed.data.sync) {
        const runId = await executeRun(session, override, undefined, {
          provider: parsed.data.provider,
          moodleDebug: parsed.data.moodleDebug,
          requireAuth: parsed.data.requireAuth,
        });
        return res.json({ ok: true, runId, sessionId: record.sessionId });
      }

      const { runId } = queueRun(session, override, {
        provider: parsed.data.provider,
        moodleDebug: parsed.data.moodleDebug,
        requireAuth: parsed.data.requireAuth,
      });
      return res.json({ ok: true, runId, sessionId: record.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Override run failed";
      return res.status(500).json(toError(message));
    }
  });

  router.get("/run/:runId/status", (req, res) => {
    const run = getRun(req.params.runId);
    if (!run) {
      return res.status(404).json(toError("Run not found", "not_found"));
    }

    return res.json({
      ok: true,
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      stage: run.stage,
      message: run.message,
      updatedAt: run.updatedAt,
      error: run.error,
      providerTrace: run.providerTrace,
      schemaValidationTrace: run.schemaValidationTrace,
    });
  });

  router.get("/session/:sessionId", (req, res) => {
    const detail = getSessionDetail(req.params.sessionId);
    if (!detail) {
      return res.status(404).json(toError("Session not found", "not_found"));
    }

    return res.json({ ok: true, detail });
  });

  router.get("/session/:sessionId/debug", (req, res) => {
    const detail = getSessionDetail(req.params.sessionId);
    if (!detail || !detail.run) {
      return res.status(404).json(toError("Session debug not found", "not_found"));
    }

    const debug = getResolverDebug(detail.run.runId);
    return res.json({ ok: true, runId: detail.run.runId, debug });
  });

  router.get("/runs/latest", (_req, res) => {
    const runs = listLatestRuns(40);
    return res.json({ ok: true, runs });
  });

  return router;
}
