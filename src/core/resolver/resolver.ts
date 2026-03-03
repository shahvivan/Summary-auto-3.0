import { loadMoodleCourses } from "../../adapters/moodle/mock-moodle.js";
import { config } from "../../config.js";
import { getAnchor } from "../../storage/sqlite.js";
import type {
  CourseSection,
  MaterialLink,
  MoodleCourse,
  ResolverDebug,
  ResolverResult,
  Session,
  SessionOverride,
} from "../../types/domain.js";
import { findCourseMapEntry } from "../../utils/course-map.js";
import { extractTopicNumber, normalizeText, tokenize } from "../../utils/text.js";
import { resolveCourseViaBrowser } from "./moodle-browser-client.js";
import { toMaterialLinks } from "./moodle-dom-parser.js";

interface ResolveSessionMaterialsOptions {
  requireAuth?: boolean;
  moodleDebug?: boolean;
}

interface SectionScoreEntry {
  section: CourseSection;
  score: number;
  reasons: string[];
  eligibleCount: number;
}

function pickCourseByName(courses: MoodleCourse[], courseName: string): MoodleCourse | null {
  const target = normalizeText(courseName);
  const exact = courses.find((course) => normalizeText(course.name) === target);
  if (exact) {
    return exact;
  }

  const tokens = tokenize(courseName);
  let best: MoodleCourse | null = null;
  let bestScore = -1;

  for (const course of courses) {
    const normalized = normalizeText(course.name);
    let score = 0;
    for (const token of tokens) {
      if (normalized.includes(token)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = course;
    }
  }

  return bestScore > 0 ? best : null;
}

function getSectionTopicNumber(section: CourseSection): number | null {
  return extractTopicNumber(section.title);
}

function getEligibleMaterialLinks(section: CourseSection): MaterialLink[] {
  return toMaterialLinks(section.resources);
}

function chooseLatestMaterials(materials: MaterialLink[]): MaterialLink[] {
  // Download everything up to the limit and let the AI decide what's relevant.
  if (materials.length <= config.resolverRecentLimit) {
    return materials;
  }

  // If there are more than the limit, prefer the most recently uploaded batch
  // so the AI always sees the newest content.
  const withDates = materials.filter((item) => item.uploadedAt);
  if (withDates.length > 0) {
    const sorted = [...withDates].sort((a, b) => {
      const aTs = new Date(a.uploadedAt!).valueOf();
      const bTs = new Date(b.uploadedAt!).valueOf();
      return bTs - aTs;
    });
    const latestTs = new Date(sorted[0]!.uploadedAt!).valueOf();
    const newestBatch = sorted.filter((item) => new Date(item.uploadedAt!).valueOf() === latestTs);
    if (newestBatch.length > 0) {
      return newestBatch.slice(0, config.resolverRecentLimit);
    }
  }

  // Fallback: take by upload order.
  return [...materials]
    .sort((a, b) => {
      const aOrder = a.orderIndex ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.orderIndex ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    })
    .slice(0, config.resolverRecentLimit);
}

function scoreSections(params: {
  sections: CourseSection[];
  session: Session;
  inferredTopicNumber: number | null;
  anchorSectionId?: string;
}): SectionScoreEntry[] {
  const sessionTokens = tokenize(`${params.session.eventTitle} ${params.session.sessionLabel ?? ""}`);
  const introPenaltyPattern = /\b(introduction|welcome|syllabus|attendance|announcement|participants|forum)\b/i;
  const maxIndex = Math.max(1, params.sections.length - 1);

  // Pre-compute the most recently uploaded timestamp across ALL sections so we
  // can give a boost to the section containing the freshest material.  This is
  // the primary signal when the ICS event has no explicit topic number (e.g.
  // Macroeconomics, Business Law II where the professor just uploaded this
  // week's slides most recently).
  let globalLatestTs = 0;
  for (const section of params.sections) {
    for (const link of getEligibleMaterialLinks(section)) {
      if (link.uploadedAt) {
        const ts = new Date(link.uploadedAt).valueOf();
        if (ts > globalLatestTs) globalLatestTs = ts;
      }
    }
  }

  return params.sections.map((section, sectionIndex) => {
    const reasons: string[] = [];
    const eligible = getEligibleMaterialLinks(section);
    const eligibleCount = eligible.length;
    let score = 0;

    const haystack = normalizeText(
      `${section.title} ${section.resources
        .map((resource) => resource.title)
        .join(" ")}`,
    );

    for (const token of sessionTokens) {
      if (haystack.includes(token)) {
        score += 1.25;
        reasons.push(`token:${token}`);
      }
    }

    if (/(topic|week|unit|chapter|lecture|session|part)/i.test(section.title)) {
      score += 0.9;
      reasons.push("academicMarker");
    }

    const sectionTopic = getSectionTopicNumber(section);
    if (params.inferredTopicNumber !== null && sectionTopic === params.inferredTopicNumber) {
      score += 6;
      reasons.push("topicExact");
    }

    if (params.anchorSectionId && section.id === params.anchorSectionId) {
      score += 3.5;
      reasons.push("historicalAnchor");
    }

    if (introPenaltyPattern.test(section.title) && eligibleCount > 0) {
      score -= 2;
      reasons.push("introPenalty");
    }

    // Bias to recent sections for non-numbered Moodle layouts.
    const indexRecencyBoost = (sectionIndex / maxIndex) * 2.2;
    score += indexRecencyBoost;
    reasons.push(`orderBoost:${indexRecencyBoost.toFixed(2)}`);

    // Numeric section headings often imply chronology (Session 6 > Session 5).
    if (sectionTopic !== null) {
      score += sectionTopic * 0.25;
      reasons.push(`topicRecency:${sectionTopic}`);
    }

    score += Math.min(eligibleCount, 5) * 0.9;
    if (eligibleCount > 0) {
      reasons.push(`resourceDensity:${eligibleCount}`);
    }

    // Strong boost for the section that contains the globally most-recently
    // uploaded material.  Professors upload the current week's slides just
    // before class — so the freshest file is almost always the right one.
    // Only apply when there is no explicit topic-number match (avoids
    // overriding a correct topicExact hit).
    if (globalLatestTs > 0 && params.inferredTopicNumber === null) {
      const sectionLatestTs = eligible.reduce((max, link) => {
        if (!link.uploadedAt) return max;
        const ts = new Date(link.uploadedAt).valueOf();
        return ts > max ? ts : max;
      }, 0);
      if (sectionLatestTs === globalLatestTs) {
        score += 4;
        reasons.push("freshestUpload");
      }
    }

    return { section, score, reasons, eligibleCount };
  });
}

function enforceOverrideContains(
  sections: CourseSection[],
  phrase: string,
): { section: CourseSection; links: MaterialLink[] } {
  const contains = normalizeText(phrase);
  const matches = sections
    .map((section) => {
      const titleMatch = normalizeText(section.title).includes(contains);
      const resourceMatch = section.resources.some((resource) =>
        normalizeText(resource.title).includes(contains),
      );
      return { section, matched: titleMatch || resourceMatch };
    })
    .filter((item) => item.matched)
    .map((item) => ({ section: item.section, links: getEligibleMaterialLinks(item.section) }))
    .filter((item) => item.links.length > 0);

  if (matches.length === 0) {
    throw new Error("Override matched no PDFs/PPTs for this course");
  }

  return matches[0]!;
}

function enforceOverrideTopicNumber(
  sections: CourseSection[],
  topicNumber: number,
): { section: CourseSection; links: MaterialLink[] } {
  const exact = sections.find((section) => getSectionTopicNumber(section) === topicNumber);
  if (exact) {
    const links = getEligibleMaterialLinks(exact);
    if (links.length > 0) {
      return { section: exact, links };
    }
  }

  const indexed = sections[topicNumber - 1];
  if (indexed) {
    const links = getEligibleMaterialLinks(indexed);
    if (links.length > 0) {
      return { section: indexed, links };
    }
  }

  throw new Error(`Override topic number matched no PDFs/PPTs: ${topicNumber}`);
}

function enforceOverrideSectionId(
  sections: CourseSection[],
  sectionId: string,
): { section: CourseSection; links: MaterialLink[] } {
  const section = sections.find((item) => item.id === sectionId);
  if (!section) {
    throw new Error(`Override sectionId not found: ${sectionId}`);
  }

  const links = getEligibleMaterialLinks(section);
  if (links.length === 0) {
    throw new Error("Override matched no PDFs/PPTs for this course");
  }

  return { section, links };
}

async function loadCourseForSession(
  session: Session,
  inferredTopicNumber: number | null,
  options?: ResolveSessionMaterialsOptions,
): Promise<{
  course: MoodleCourse;
  navigationSteps: string[];
  domStats: ResolverDebug["domStats"];
  htmlSnapshot?: string;
}> {
  const mapped = await findCourseMapEntry(session.courseName);
  if (config.resolverUseLiveMoodle) {
    const live = await resolveCourseViaBrowser({
      courseName: session.courseName,
      preferredCourseUrl: mapped?.url,
      inferredTopicNumber,
      requireAuth: options?.requireAuth ?? true,
      moodleDebug: options?.moodleDebug ?? false,
    });
    return {
      course: {
        id: live.courseId,
        name: live.courseName,
        url: live.courseUrl,
        sections: live.sections,
      },
      navigationSteps: live.navigationSteps,
      domStats: live.domStats,
      htmlSnapshot: live.htmlSnapshot,
    };
  }

  const courses = await loadMoodleCourses();
  let course: MoodleCourse | null = null;

  if (mapped) {
    course =
      courses.find((candidate) => candidate.url === mapped.url) ||
      courses.find((candidate) => normalizeText(candidate.name) === normalizeText(mapped.courseName)) ||
      null;
  }
  if (!course) {
    course = pickCourseByName(courses, session.courseName);
  }

  if (!course) {
    throw new Error(`Unable to resolve Moodle course by name: ${session.courseName}`);
  }

  const resourceCount = course.sections.reduce((acc, section) => acc + section.resources.length, 0);
  const pdfResources = course.sections.reduce(
    (acc, section) => acc + section.resources.filter((resource) => resource.type === "pdf").length,
    0,
  );
  const pptResources = course.sections.reduce(
    (acc, section) => acc + section.resources.filter((resource) => resource.type === "ppt").length,
    0,
  );

  return {
    course,
    navigationSteps: ["Mock resolver mode enabled"],
    domStats: {
      sectionCount: course.sections.length,
      resourceCount,
      pdfResources,
      pptResources,
    },
    htmlSnapshot: undefined,
  };
}

export async function resolveSessionMaterials(
  session: Session,
  override?: SessionOverride,
  options?: ResolveSessionMaterialsOptions,
): Promise<{ courseId: string; courseName: string; result: ResolverResult }> {
  const anchor = getAnchor(session.courseKey);
  const inferredTopicNumber = extractTopicNumber(`${session.eventTitle} ${session.sessionLabel ?? ""}`);

  const loaded = await loadCourseForSession(session, inferredTopicNumber, options);
  const course = loaded.course;

  let selectedSection: CourseSection | null = null;
  let selectedLinks: MaterialLink[] = [];
  let overrideApplied: ResolverDebug["overrideApplied"] = "automatic";
  let selectedReason = "automatic scoring";

  if (override?.sectionId) {
    const strict = enforceOverrideSectionId(course.sections, override.sectionId);
    selectedSection = strict.section;
    selectedLinks = strict.links;
    overrideApplied = "sectionId";
    selectedReason = "strict sectionId override";
  } else if (override?.topicNumber !== undefined) {
    const strict = enforceOverrideTopicNumber(course.sections, override.topicNumber);
    selectedSection = strict.section;
    selectedLinks = strict.links;
    overrideApplied = "topicNumber";
    selectedReason = "strict topic number override";
  } else if (override?.contains) {
    const strict = enforceOverrideContains(course.sections, override.contains);
    selectedSection = strict.section;
    selectedLinks = strict.links;
    overrideApplied = "contains";
    selectedReason = "strict contains override";
  } else if (anchor) {
    const anchored = course.sections.find((section) => section.id === anchor.sectionId);
    if (anchored) {
      const links = getEligibleMaterialLinks(anchored);
      if (links.length > 0) {
        selectedSection = anchored;
        selectedLinks = links;
        overrideApplied = "anchor";
        selectedReason = "historical anchor";
      }
    }
  }

  const scored = scoreSections({
    sections: course.sections,
    session,
    inferredTopicNumber,
    anchorSectionId: anchor?.sectionId,
  }).sort((a, b) => b.score - a.score);

  if (!selectedSection) {
    const bestWithMaterials = scored.find((entry) => entry.eligibleCount > 0) ?? scored[0];
    if (!bestWithMaterials) {
      throw new Error(`No sections found in course: ${course.name}`);
    }

    selectedSection = bestWithMaterials.section;
    selectedLinks = getEligibleMaterialLinks(bestWithMaterials.section);
    selectedReason = bestWithMaterials.reasons.join(", ") || "highest score";
  }

  if (selectedLinks.length === 0) {
    throw new Error(`No PDF/PPT materials found in selected section: ${selectedSection.title}`);
  }

  const chosenLinks = chooseLatestMaterials(selectedLinks);

  const topScore = scored[0]?.score ?? 1;
  const selectedScore = scored.find((entry) => entry.section.id === selectedSection?.id)?.score ?? topScore;
  const confidenceScore = topScore <= 0 ? 0 : Math.max(0, Math.min(1, selectedScore / topScore));

  return {
    courseId: course.id,
    courseName: course.name,
    result: {
      selectedSectionId: selectedSection.id,
      selectedSectionTitle: selectedSection.title,
      pdfLinks: chosenLinks,
      debug: {
        allSections: scored.map((entry) => ({
          sectionId: entry.section.id,
          sectionTitle: entry.section.title,
          score: Number(entry.score.toFixed(4)),
          reasons: entry.reasons,
          pdfCount: entry.eligibleCount,
        })),
        overrideApplied,
        confidenceScore: Number(confidenceScore.toFixed(4)),
        selectedReason,
        navigationSteps: loaded.navigationSteps,
        domStats: loaded.domStats,
        pdfFilterStats: {
          inputResources: selectedSection.resources.length,
          pdfResources: selectedLinks.filter((item) => item.type === "pdf").length,
          pptResources: selectedLinks.filter((item) => item.type === "ppt").length,
          selectedResources: chosenLinks.length,
        },
        htmlSnapshot: loaded.htmlSnapshot,
      },
    },
  };
}
