import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionMaterials } from "../src/core/resolver/resolver.js";
import { createManualSession } from "../src/core/scheduler/engine.js";
import { saveAnchor } from "../src/storage/sqlite.js";
import { resetStorage } from "./helpers.js";

test("resolver override priority: sectionId > topicNumber > contains", async () => {
  await resetStorage();

  const session = createManualSession({
    courseName: "Descriptive Statistics & Probability",
    date: "2026-03-02",
    eventTitle: "Prepare Topic 3 for class",
    sessionLabel: "Topic 3",
  });

  const out = await resolveSessionMaterials(session, {
    sectionId: "sec-topic-2",
    topicNumber: 3,
    contains: "Topic 3",
  });

  assert.equal(out.result.selectedSectionId, "sec-topic-2");
  assert.equal(out.result.debug.overrideApplied, "sectionId");
});

test("resolver override contains is strict and errors when no PDFs match", async () => {
  await resetStorage();

  const session = createManualSession({
    courseName: "Descriptive Statistics & Probability",
    date: "2026-03-02",
    eventTitle: "Prepare Topic 3 for class",
  });

  await assert.rejects(
    () => resolveSessionMaterials(session, { contains: "Introduction" }),
    /Override matched no PDFs\/PPTs for this course/,
  );
});

test("resolver ignores non-PDF resources", async () => {
  await resetStorage();

  const session = createManualSession({
    courseName: "Descriptive Statistics & Probability",
    date: "2026-03-02",
    eventTitle: "Prepare Topic 3 for class",
  });

  const out = await resolveSessionMaterials(session, { topicNumber: 3 });
  assert.equal(out.result.selectedSectionId, "sec-topic-3");
  assert.equal(out.result.pdfLinks.length, 2);
  assert.ok(out.result.pdfLinks.every((link) => link.url.endsWith(".pdf")));
});

test("resolver uses historical anchor when present", async () => {
  await resetStorage();

  const session = createManualSession({
    courseName: "Descriptive Statistics & Probability",
    date: "2026-03-04",
    eventTitle: "Topic 1 reminder",
  });

  saveAnchor(session.courseKey, "sec-topic-4", "Topic 4 - Measures of Dispersion");
  const out = await resolveSessionMaterials(session);

  assert.equal(out.result.selectedSectionId, "sec-topic-4");
  assert.equal(out.result.debug.overrideApplied, "anchor");
});

test("resolver returns newest PDF/PPT subset deterministically", async () => {
  await resetStorage();

  const session = createManualSession({
    courseName: "Linear Algebra",
    date: "2026-03-05",
    eventTitle: "Week 5 vectors and subspaces",
  });

  const out = await resolveSessionMaterials(session, { topicNumber: 5 });
  assert.equal(out.result.selectedSectionId, "la-week-5");
  assert.equal(out.result.pdfLinks.length, 2);
  assert.deepEqual(
    out.result.pdfLinks.map((item) => item.id),
    ["la-w5-pdf-1", "la-w5-pdf-2"],
  );
});
