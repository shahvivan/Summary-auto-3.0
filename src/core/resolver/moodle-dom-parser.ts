import type { CourseResource, CourseSection, MaterialLink, ResourceType } from "../../types/domain.js";

export interface RawMoodleResource {
  id: string;
  title: string;
  url: string;
  iconHint?: string;
  typeHint?: string;
  metaText?: string;
  orderIndex: number;
  subsectionLabel?: string;
}

export interface RawMoodleSection {
  id: string;
  title: string;
  orderIndex: number;
  resources: RawMoodleResource[];
}

function normalizeSpaces(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function parseDateLike(value: string): string | undefined {
  const dateMatch = value.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const year = Number(dateMatch[3].length === 2 ? `20${dateMatch[3]}` : dateMatch[3]);
    if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month - 1, day)).toISOString();
    }
  }

  const isoMatch = value.match(/\b\d{4}-\d{2}-\d{2}(?:[ tT]\d{2}:\d{2}(?::\d{2})?)?/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

export function detectResourceType(resource: RawMoodleResource): ResourceType {
  const haystack = `${resource.title} ${resource.url} ${resource.iconHint ?? ""} ${resource.typeHint ?? ""} ${resource.metaText ?? ""}`.toLowerCase();
  if (/\b(pdf|application\/pdf)\b/.test(haystack) || /\.pdf(\?|$)/.test(haystack)) {
    return "pdf";
  }
  if (/\b(ppt|pptx|powerpoint|presentation)\b/.test(haystack) || /\.pptx?(\?|$)/.test(haystack)) {
    return "ppt";
  }
  if (/\b(doc|docx|word)\b/.test(haystack)) {
    return "doc";
  }
  if (/\b(xls|xlsx|excel)\b/.test(haystack)) {
    return "xlsx";
  }
  if (/\b(video|youtube|vimeo)\b/.test(haystack)) {
    return "video";
  }
  if (/\bhttps?:\/\//.test(haystack)) {
    return "link";
  }
  return "other";
}

export function parseSectionResources(sections: RawMoodleSection[]): CourseSection[] {
  return sections.map((section) => ({
    id: section.id,
    title: normalizeSpaces(section.title || "Untitled Section"),
    resources: section.resources.map((resource) => {
      const type = detectResourceType(resource);
      const uploadedAt = parseDateLike(resource.metaText ?? "");
      const normalized: CourseResource = {
        id: resource.id,
        title: normalizeSpaces(resource.title || resource.url || "Untitled Resource"),
        url: resource.url,
        type,
        uploadedAt,
        orderIndex: resource.orderIndex,
        subsectionLabel: resource.subsectionLabel || undefined,
      };
      return normalized;
    }),
  }));
}

export function toMaterialLinks(resources: CourseResource[]): MaterialLink[] {
  return resources
    .filter((resource) => resource.type === "pdf" || resource.type === "ppt")
    .map((resource) => ({
      id: resource.id,
      title: resource.title,
      url: resource.url,
      type: resource.type as "pdf" | "ppt",
      uploadedAt: resource.uploadedAt,
      orderIndex: resource.orderIndex,
      subsectionLabel: resource.subsectionLabel,
    }));
}
