import path from "node:path";
import { z } from "zod";
import { config } from "../../config.js";
import type { ScheduleEvent } from "../../types/domain.js";
import { readJsonFile } from "../../utils/fs.js";

const eventSchema = z.object({
  id: z.string(),
  courseName: z.string(),
  title: z.string(),
  date: z.string(),
  topicLabel: z.string().optional(),
});

const calendarSchema = z.array(eventSchema);

export async function loadCalendarEvents(): Promise<ScheduleEvent[]> {
  const file = path.join(config.mockDir, "calendar-events.json");
  const raw = await readJsonFile<unknown>(file, []);
  const parsed = calendarSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  return parsed.data;
}
