import { config } from "../../config.js";
import type { CourseSection } from "../../types/domain.js";
import { normalizeText, tokenize } from "../../utils/text.js";
import { looksLikeLoginPage, resolveUserDataDir } from "./auth-profile.js";
import { parseSectionResources, type RawMoodleSection } from "./moodle-dom-parser.js";

interface BrowserResolveParams {
  courseName: string;
  preferredCourseUrl?: string;
  inferredTopicNumber?: number | null;
  requireAuth?: boolean;
  moodleDebug?: boolean;
}

export interface BrowserResolveResult {
  courseId: string;
  courseName: string;
  courseUrl: string;
  sections: CourseSection[];
  navigationSteps: string[];
  domStats: {
    sectionCount: number;
    resourceCount: number;
    pdfResources: number;
    pptResources: number;
  };
  htmlSnapshot?: string;
}

function ensureLiveResolverConfigured(): void {
  if (!config.moodleBaseUrl) {
    throw new Error("MOODLE_BASE_URL is required for live resolver mode");
  }
}

async function findCourseUrlFromDashboard(page: import("playwright").Page, courseName: string): Promise<string | null> {
  const candidates = await page.$$eval('a[href*="/course/view.php"]', (links) =>
    links
      .map((link) => ({
        href: (link as HTMLAnchorElement).href,
        text: (link.textContent || "").trim(),
      }))
      .filter((item) => item.href && item.text),
  );

  if (candidates.length === 0) {
    return null;
  }

  const query = normalizeText(courseName);
  const tokens = tokenize(query);
  let bestHref: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate.text);
    let score = 0;
    if (normalized === query) {
      score += 100;
    }
    if (normalized.includes(query) || query.includes(normalized)) {
      score += 40;
    }
    for (const token of tokens) {
      if (normalized.includes(token)) {
        score += 3;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestHref = candidate.href;
    }
  }

  return bestScore > 0 ? bestHref : null;
}

async function maybeActivateTopicTab(
  page: import("playwright").Page,
  inferredTopicNumber: number | null | undefined,
  navigationSteps: string[],
): Promise<void> {
  if (!inferredTopicNumber) {
    return;
  }

  const clicked = await page
    .locator("a,button")
    .filter({
      hasText: new RegExp(`\\b(topic|session|week|unit|part)\\s*${inferredTopicNumber}\\b`, "i"),
    })
    .first()
    .isVisible()
    .catch(() => false);
  if (!clicked) {
    return;
  }

  await page
    .locator("a,button")
    .filter({
      hasText: new RegExp(`\\b(topic|session|week|unit|part)\\s*${inferredTopicNumber}\\b`, "i"),
    })
    .first()
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  await page.waitForTimeout(500);
  navigationSteps.push(`Activated tab/topic with number ${inferredTopicNumber}`);
}

async function expandAllVisibleSections(page: import("playwright").Page, navigationSteps: string[]): Promise<void> {
  const selectors = [
    'button[aria-expanded="false"]',
    ".accordion-button.collapsed",
    ".collapseexpand .expandall",
    "[data-action=\"expand\"]",
    "a[href=\"#\"][role=\"button\"]",
  ];
  let clicks = 0;

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const handle = locator.nth(i);
      const visible = await handle.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      await handle.click({ timeout: 2_000 }).catch(() => undefined);
      clicks += 1;
    }
  }

  if (clicks > 0) {
    navigationSteps.push(`Expanded ${clicks} collapsible controls`);
  }
}

async function extractRawSections(page: import("playwright").Page): Promise<RawMoodleSection[]> {
  return page.evaluate(() => {
    function text(node: Element | null | undefined): string {
      if (!node) {
        return "";
      }
      return (node.textContent || "").replace(/\s+/g, " ").trim();
    }

    const sectionSelectors = [
      ".course-content .section",
      ".topics .section",
      "[data-region='section']",
      ".accordion-item",
      ".course-section",
      ".single-section",
    ];

    let sectionNodes: Element[] = [];
    for (const selector of sectionSelectors) {
      const found = Array.from(document.querySelectorAll(selector));
      if (found.length > sectionNodes.length) {
        sectionNodes = found;
      }
    }

    const globalResources = Array.from(
      document.querySelectorAll(
        "a[href*='mod/resource/view.php'], a[href*='pluginfile.php'], li.activity a, .resourceworkaround a, .activityinstance a, a.aalink",
      ),
    );

    if (sectionNodes.length === 0 && globalResources.length > 0) {
      sectionNodes = [document.body];
    }

    const sections: RawMoodleSection[] = [];

    for (let sectionIndex = 0; sectionIndex < sectionNodes.length; sectionIndex += 1) {
      const sectionNode = sectionNodes[sectionIndex]!;
      const sectionId =
        sectionNode.getAttribute("id") ||
        sectionNode.getAttribute("data-id") ||
        sectionNode.getAttribute("data-sectionid") ||
        `section-${sectionIndex + 1}`;

      const titleNode =
        sectionNode.querySelector("h2, h3, h4, .sectionname, .instancename, .card-title, .nav-link.active") ||
        sectionNode.querySelector("summary, .accordion-header, .section-title");
      const sectionTitle = text(titleNode) || `Section ${sectionIndex + 1}`;

      const resourceNodes = Array.from(
        sectionNode.querySelectorAll(
          "a[href*='mod/resource/view.php'], a[href*='pluginfile.php'], li.activity a, .resourceworkaround a, .activityinstance a, a.aalink",
        ),
      );

      const resources: RawMoodleSection["resources"] = [];
      const seen = new Set<string>();

      for (let resourceIndex = 0; resourceIndex < resourceNodes.length; resourceIndex += 1) {
        const anchor = resourceNodes[resourceIndex] as HTMLAnchorElement;
        const href = anchor.href || anchor.getAttribute("href") || "";
        if (!href) {
          continue;
        }

        const parent = anchor.closest("li, .activity, .activity-item, .modtype_resource, .card, tr, .row") || anchor.parentElement;
        const lineText = text(parent);
        const titleText =
          text(anchor.querySelector(".instancename")) ||
          text(anchor.querySelector(".resourcelinkdetails")) ||
          text(anchor) ||
          lineText;
        const icon = anchor.querySelector("img, i, .icon, .fp-icon");
        const iconHint = icon ? `${icon.getAttribute("alt") || ""} ${icon.getAttribute("class") || ""} ${icon.getAttribute("src") || ""}` : "";
        const typeHint =
          text(parent?.querySelector(".activitytype, .type, .text-uppercase, .resource-type")) ||
          text(anchor.parentElement?.querySelector(".activitytype, .type"));
        const dedupe = `${href}|${titleText}`;
        if (seen.has(dedupe)) {
          continue;
        }
        seen.add(dedupe);

        resources.push({
          id: anchor.id || `resource-${sectionIndex + 1}-${resourceIndex + 1}`,
          title: titleText || `Resource ${resourceIndex + 1}`,
          url: href,
          iconHint,
          typeHint,
          metaText: lineText,
          orderIndex: resourceIndex,
        });
      }

      sections.push({
        id: sectionId,
        title: sectionTitle,
        orderIndex: sectionIndex,
        resources,
      });
    }

    return sections;
  });
}

export async function resolveCourseViaBrowser(params: BrowserResolveParams): Promise<BrowserResolveResult> {
  ensureLiveResolverConfigured();

  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("Live resolver requires the 'playwright' package. Run: npm install playwright");
  }

  const navigationSteps: string[] = [];
  const userDataDir = resolveUserDataDir();
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: config.playwrightHeadless,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    // Use "load" (not "domcontentloaded") so that any SSO redirect chain
    // (e.g. ESADE SAML → ecampus) has fully settled before we inspect the page.
    await page.goto(config.moodleBaseUrl, { waitUntil: "load", timeout: 60_000 });
    // If the browser is still on an intermediate auth page, wait a little
    // longer for the final redirect to complete.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    navigationSteps.push(`Opened Moodle base URL: ${config.moodleBaseUrl}`);
    if (params.moodleDebug) {
      navigationSteps.push(`Current URL after base open: ${page.url()}`);
    }

    const authProbe = await page.evaluate(() => {
      const hasPasswordInput = Boolean(document.querySelector("input[type='password']"));
      return {
        title: document.title,
        hasPasswordInput,
      };
    });

    if (looksLikeLoginPage({ url: page.url(), title: authProbe.title, hasPasswordInput: authProbe.hasPasswordInput })) {
      const reason = "auth_required";
      if (params.requireAuth ?? true) {
        throw new Error(`${reason}: Moodle session is not authenticated in the persistent profile`);
      }
      navigationSteps.push("Detected unauthenticated state, continuing because requireAuth=false");
    }

    const targetCourseUrl =
      params.preferredCourseUrl || (await findCourseUrlFromDashboard(page, params.courseName)) || null;
    if (!targetCourseUrl) {
      throw new Error(`course_not_found: Could not locate course URL for '${params.courseName}'`);
    }

    await page.goto(targetCourseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    navigationSteps.push(`Opened course URL: ${targetCourseUrl}`);
    if (params.moodleDebug) {
      navigationSteps.push(`Course page title: ${await page.title()}`);
    }

    await maybeActivateTopicTab(page, params.inferredTopicNumber, navigationSteps);
    await expandAllVisibleSections(page, navigationSteps);
    const rawSections = await extractRawSections(page);
    const parsedSections = parseSectionResources(rawSections);

    const resourceCount = parsedSections.reduce((acc, section) => acc + section.resources.length, 0);
    const pdfResources = parsedSections.reduce(
      (acc, section) => acc + section.resources.filter((resource) => resource.type === "pdf").length,
      0,
    );
    const pptResources = parsedSections.reduce(
      (acc, section) => acc + section.resources.filter((resource) => resource.type === "ppt").length,
      0,
    );

    const heading = await page.locator("h1").first().textContent().catch(() => null);
    const htmlSnapshot = params.moodleDebug ? await page.content().catch(() => undefined) : undefined;

    return {
      courseId: `live-${new URL(targetCourseUrl).searchParams.get("id") ?? "course"}`,
      courseName: heading?.trim() || params.courseName,
      courseUrl: targetCourseUrl,
      sections: parsedSections,
      navigationSteps,
      domStats: {
        sectionCount: parsedSections.length,
        resourceCount,
        pdfResources,
        pptResources,
      },
      htmlSnapshot,
    };
  } finally {
    await context.close();
  }
}
