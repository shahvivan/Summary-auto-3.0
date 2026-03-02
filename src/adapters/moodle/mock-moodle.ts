import path from "node:path";
import { z } from "zod";
import { config } from "../../config.js";
import type { MoodleCourse } from "../../types/domain.js";
import { readJsonFile } from "../../utils/fs.js";

const resourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(["pdf", "ppt", "doc", "xlsx", "link", "video", "other"]).default("other"),
  url: z.string(),
  mimetype: z.string().optional(),
  uploadedAt: z.string().optional(),
  orderIndex: z.number().optional(),
});

const sectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  resources: z.array(resourceSchema),
});

const courseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().optional(),
  url: z.string().optional(),
  sections: z.array(sectionSchema),
});

const coursesSchema = z.array(courseSchema);

export async function loadMoodleCourses(): Promise<MoodleCourse[]> {
  const file = path.join(config.mockDir, "moodle-courses.json");
  const raw = await readJsonFile<unknown>(file, []);
  const parsed = coursesSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  return parsed.data;
}
