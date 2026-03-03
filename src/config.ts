import path from "node:path";

const root = process.cwd();

export const config = {
  root,
  port: Number(process.env.PORT ?? 3100),
  timezone: process.env.APP_TIMEZONE ?? "Europe/Madrid",
  storageDir: path.join(root, "data", "storage"),
  configDir: path.join(root, "data", "config"),
  mockDir: path.join(root, "data", "mock"),
  courseMapPath: path.join(root, "data", "config", "course-map.json"),
  dbPath: path.join(root, "data", "storage", "app.db"),
  cacheDir: path.join(root, "data", "storage", "cache"),
  runDebugDir: path.join(root, "data", "storage", "debug"),
  maxChunkChars: Number(process.env.MAX_CHUNK_CHARS ?? 2400),
  calendarUseIcs: String(process.env.CALENDAR_USE_ICS ?? "false").toLowerCase() === "true",
  calendarIcsUrl: process.env.CALENDAR_ICS_URL ?? "",
  allowMockFallback: String(process.env.ALLOW_MOCK_FALLBACK ?? "false").toLowerCase() === "true",
  moodleBaseUrl: process.env.MOODLE_BASE_URL ?? "",
  resolverUseLiveMoodle: String(process.env.RESOLVER_USE_LIVE_MOODLE ?? "false").toLowerCase() === "true",
  resolverRecentLimit: Math.max(1, Number(process.env.RESOLVER_RECENT_LIMIT ?? 2)),
  playwrightUserDataDir: process.env.PLAYWRIGHT_USER_DATA_DIR || path.join(root, "data", "playwright-profile"),
  playwrightHeadless: String(process.env.PLAYWRIGHT_HEADLESS ?? "true").toLowerCase() === "true",
  summaryProviderDefault: (process.env.SUMMARY_PROVIDER_DEFAULT ?? "gemini").toLowerCase(),
  summaryFallbackEnabled: String(process.env.SUMMARY_FALLBACK_ENABLED ?? "true").toLowerCase() === "true",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  chatpdfApiKey: process.env.CHATPDF_API_KEY ?? "",
  chatpdfSourceId: process.env.CHATPDF_SOURCE_ID ?? "",
  geminiEnabled:
    (process.env.GEMINI_API_KEY ?? "").trim().length > 0 &&
    (process.env.GEMINI_MODEL ?? "gemini-2.0-flash").trim().length > 0,
  chatpdfEnabled:
    (process.env.CHATPDF_API_KEY ?? "").trim().length > 0 &&
    (process.env.CHATPDF_SOURCE_ID ?? "").trim().length > 0,
  deterministicEnabled: true,
};
