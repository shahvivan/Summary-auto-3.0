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
  // Step 1: Click the global "Expand all" button first — this is the most reliable
  // way to open all collapsed accordion sections in Moodle's Boost theme.
  const expandAllLocator = page.locator(
    'a[data-action="expandall"], .collapseexpand a.expandall, a:has-text("Expand all"), button:has-text("Expand all")',
  );
  const expandAllCount = await expandAllLocator.count().catch(() => 0);
  if (expandAllCount > 0) {
    await expandAllLocator.first().click({ timeout: 3_000 }).catch(() => undefined);
    // Wait for the sections to animate open.
    await page.waitForTimeout(800);
    navigationSteps.push("Clicked global Expand all button");
  }

  // Step 2: Fall back to clicking any remaining collapsed individual controls.
  // IMPORTANT: Keep selectors scoped to Moodle course-content containers so we
  // don't accidentally click navigation dropdowns, modal triggers, or other
  // collapsed UI widgets that happen to use aria-expanded="false".
  const individualSelectors = [
    '[data-action="expandcontent"]',       // Moodle 4.x section toggle
    '[data-action="sectionshow"]',         // Moodle 4.x hidden-section show
    // Scope the generic ARIA button selector to known Moodle course regions to
    // avoid clicking unrelated collapsed UI (menus, modals, nav dropdowns, etc.)
    '#region-main button[aria-expanded="false"]',
    '.course-content button[aria-expanded="false"]',
    '.course-section button[aria-expanded="false"]',
    ".accordion-button.collapsed",
    '[data-action="expand"]',
    'a[href="#"][role="button"]',
  ];
  let clicks = 0;

  for (const selector of individualSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const handle = locator.nth(i);
      const visible = await handle.isVisible().catch(() => false);
      if (!visible) continue;
      await handle.click({ timeout: 2_000 }).catch(() => undefined);
      clicks += 1;
    }
  }

  if (clicks > 0) {
    navigationSteps.push(`Expanded ${clicks} individual collapsible controls`);
  }
}

async function extractRawSections(page: import("playwright").Page): Promise<RawMoodleSection[]> {
  return page.evaluate(() => {
    // tsx compiles with keepNames:true, which transforms every
    //   const fn = (x) => { ... }
    // into
    //   const fn = __name((x) => { ... }, "fn")
    // __name is a module-level esbuild helper that does not exist in
    // browser scope.  Using an object-method shorthand avoids the injection
    // because the JS engine sets .name from the property key automatically.
    const u = {
      text(node: Element | null | undefined): string {
        if (!node) return "";
        return (node.textContent || "").replace(/\s+/g, " ").trim();
      },
    };

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

      // Try progressively more specific selectors; Moodle Boost (ESADE) uses
      // .sectionname inside h3, or .course-section-header.  Fall back to
      // generic headings so we still work on other Moodle themes.
      const titleNode =
        sectionNode.querySelector(".sectionname") ||
        sectionNode.querySelector(".course-section-header h3, .course-section-header h2") ||
        sectionNode.querySelector(".section-title, .section_title") ||
        sectionNode.querySelector("h2, h3, h4") ||
        sectionNode.querySelector(".instancename, .card-title, .nav-link.active") ||
        sectionNode.querySelector("summary, .accordion-header");
      const sectionTitle = u.text(titleNode) || `Section ${sectionIndex + 1}`;

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
        const lineText = u.text(parent);
        const titleText =
          u.text(anchor.querySelector(".instancename")) ||
          u.text(anchor.querySelector(".resourcelinkdetails")) ||
          u.text(anchor) ||
          lineText;
        const icon = anchor.querySelector("img, i, .icon, .fp-icon");
        const iconHint = icon ? `${icon.getAttribute("alt") || ""} ${icon.getAttribute("class") || ""} ${icon.getAttribute("src") || ""}` : "";
        const typeHint =
          u.text(parent?.querySelector(".activitytype, .type, .text-uppercase, .resource-type")) ||
          u.text(anchor.parentElement?.querySelector(".activitytype, .type"));
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
