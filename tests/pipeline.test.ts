import assert from "node:assert/strict";
import test from "node:test";
import { executeRun } from "../src/core/orchestrator/pipeline.js";
import { createManualSession, getEventsForDate, toSession } from "../src/core/scheduler/engine.js";
import { getSessionDetail, listSessionsForDate, upsertSession } from "../src/storage/sqlite.js";
import { resetStorage } from "./helpers.js";

test("pipeline generates deterministic summary for manual session", async () => {
  await resetStorage();

  const session = createManualSession({
    courseName: "Descriptive Statistics & Probability",
    date: "2026-03-02",
    eventTitle: "Prepare Topic 3 for Descriptive Statistics",
    sessionLabel: "Topic 3",
  });
  upsertSession(session);

  const runId = await executeRun(session, { topicNumber: 3 });
  const detail = getSessionDetail(session.sessionId);

  assert.ok(detail);
  assert.equal(detail?.run?.runId, runId);
  assert.equal(detail?.run?.status, "done");
  assert.equal(detail?.resolverResult?.selectedSectionId, "sec-topic-3");
  assert.ok((detail?.summary?.layer1KeyConcepts.length ?? 0) > 0);
  assert.ok((detail?.materials.length ?? 0) === 2);
});

test("course isolation: runs from two courses never mix materials", async () => {
  await resetStorage();

  const dsp = createManualSession({
    courseName: "Descriptive Statistics & Probability",
    date: "2026-03-02",
    eventTitle: "Prepare Topic 3 for Descriptive Statistics",
  });
  const la = createManualSession({
    courseName: "Linear Algebra",
    date: "2026-03-02",
    eventTitle: "Week 5 vectors and subspaces",
    sessionLabel: "Week 5",
  });

  upsertSession(dsp);
  upsertSession(la);

  await executeRun(dsp, { topicNumber: 3 });
  await executeRun(la, { topicNumber: 5 });

  const dspDetail = getSessionDetail(dsp.sessionId);
  const laDetail = getSessionDetail(la.sessionId);

  assert.ok(dspDetail);
  assert.ok(laDetail);
  assert.ok(dspDetail!.materials.every((item) => item.url.includes("descriptive-statistics")));
  assert.ok(laDetail!.materials.every((item) => item.url.includes("linear-algebra")));
  assert.notEqual(dspDetail!.resolverResult?.selectedSectionId, laDetail!.resolverResult?.selectedSectionId);
});

test("autopilot date load produces reproducible done sessions", async () => {
  await resetStorage();

  const events = await getEventsForDate("2026-03-02");
  for (const event of events) {
    const session = toSession(event);
    upsertSession(session);
    await executeRun(session);
  }

  const sessions = listSessionsForDate("2026-03-02");
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((session) => session.status === "done"));
});
