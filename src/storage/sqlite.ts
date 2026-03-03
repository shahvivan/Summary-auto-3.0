import Database from "better-sqlite3";
import path from "node:path";
import { config } from "../config.js";
import type {
  ProviderTrace,
  ResolverResult,
  RunRecord,
  SchemaValidationTrace,
  Session,
  SessionDetail,
  SessionOverride,
  SessionRecord,
  SummaryOutput,
} from "../types/domain.js";
import { ensureDir } from "../utils/fs.js";
import { nowIso } from "../utils/text.js";

let db: Database.Database | null = null;

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as T;
}

function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized");
  }
  return db;
}

function ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
  const columns = getDb().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  getDb().exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

export async function initStorage(): Promise<void> {
  await ensureDir(config.storageDir);
  await ensureDir(config.cacheDir);
  await ensureDir(config.runDebugDir);

  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      course_key TEXT NOT NULL,
      course_name TEXT NOT NULL,
      date TEXT NOT NULL,
      event_title TEXT NOT NULL,
      session_label TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      course_key TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      message TEXT,
      override_json TEXT,
      error TEXT,
      provider_trace_json TEXT,
      schema_validation_trace_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS anchors (
      course_key TEXT PRIMARY KEY,
      section_id TEXT NOT NULL,
      section_title TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      course_key TEXT NOT NULL,
      override_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      course_key TEXT NOT NULL,
      section_id TEXT NOT NULL,
      section_title TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      resource_title TEXT NOT NULL,
      resource_url TEXT NOT NULL,
      content_hash TEXT,
      extracted_text TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS summaries (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      course_key TEXT NOT NULL,
      resolver_result_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resolver_debug (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      course_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
    CREATE INDEX IF NOT EXISTS idx_sessions_course_key ON sessions(course_key);
    CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_materials_session_run ON materials(session_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
  `);

  ensureColumn("runs", "provider_trace_json", "TEXT");
  ensureColumn("runs", "schema_validation_trace_json", "TEXT");
}

export function closeStorage(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function upsertSession(input: Session): SessionRecord {
  const now = nowIso();
  const existing = getDb()
    .prepare(
      `SELECT session_id, course_key, course_name, date, event_title, session_label, status, created_at, updated_at, last_run_id FROM sessions WHERE session_id = ?`,
    )
    .get(input.sessionId) as
    | {
        session_id: string;
        course_key: string;
        course_name: string;
        date: string;
        event_title: string;
        session_label: string | null;
        status: string;
        created_at: string;
        updated_at: string;
        last_run_id: string | null;
      }
    | undefined;

  if (!existing) {
    getDb()
      .prepare(
        `INSERT INTO sessions(session_id, course_key, course_name, date, event_title, session_label, status, created_at, updated_at, last_run_id)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL)`,
      )
      .run(input.sessionId, input.courseKey, input.courseName, input.date, input.eventTitle, input.sessionLabel ?? null, now, now);

    return {
      ...input,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
  }

  getDb()
    .prepare(
      `UPDATE sessions
       SET course_key = ?, course_name = ?, date = ?, event_title = ?, session_label = ?, updated_at = ?
       WHERE session_id = ?`,
    )
    .run(input.courseKey, input.courseName, input.date, input.eventTitle, input.sessionLabel ?? null, now, input.sessionId);

  return {
    ...input,
    status: existing.status as SessionRecord["status"],
    createdAt: existing.created_at,
    updatedAt: now,
    lastRunId: existing.last_run_id ?? undefined,
  };
}

export function listSessionsForDate(date: string): SessionRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id, course_key, course_name, date, event_title, session_label, status, created_at, updated_at, last_run_id
       FROM sessions
       WHERE date = ?
       ORDER BY course_name ASC, session_id ASC`,
    )
    .all(date) as Array<{
    session_id: string;
    course_key: string;
    course_name: string;
    date: string;
    event_title: string;
    session_label: string | null;
    status: string;
    created_at: string;
    updated_at: string;
    last_run_id: string | null;
  }>;

  return rows.map((row) => ({
    sessionId: row.session_id,
    courseKey: row.course_key,
    courseName: row.course_name,
    date: row.date,
    eventTitle: row.event_title,
    sessionLabel: row.session_label ?? undefined,
    status: row.status as SessionRecord["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id ?? undefined,
  }));
}

export function getSession(sessionId: string): SessionRecord | null {
  const row = getDb()
    .prepare(
      `SELECT session_id, course_key, course_name, date, event_title, session_label, status, created_at, updated_at, last_run_id
       FROM sessions
       WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        session_id: string;
        course_key: string;
        course_name: string;
        date: string;
        event_title: string;
        session_label: string | null;
        status: string;
        created_at: string;
        updated_at: string;
        last_run_id: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    sessionId: row.session_id,
    courseKey: row.course_key,
    courseName: row.course_name,
    date: row.date,
    eventTitle: row.event_title,
    sessionLabel: row.session_label ?? undefined,
    status: row.status as SessionRecord["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id ?? undefined,
  };
}

export function createRun(input: {
  runId: string;
  sessionId: string;
  courseKey: string;
  override?: SessionOverride;
}): RunRecord {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO runs(
        run_id, session_id, course_key, status, stage, message, override_json, error,
        provider_trace_json, schema_validation_trace_json, created_at, updated_at
      )
       VALUES (?, ?, ?, 'running', 'queued', 'Queued', ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(input.runId, input.sessionId, input.courseKey, toJson(input.override), now, now);

  getDb()
    .prepare(`UPDATE sessions SET status = 'running', updated_at = ?, last_run_id = ? WHERE session_id = ?`)
    .run(now, input.runId, input.sessionId);

  if (input.override && Object.keys(input.override).length > 0) {
    getDb()
      .prepare(
        `INSERT INTO overrides(run_id, session_id, course_key, override_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.runId, input.sessionId, input.courseKey, toJson(input.override), now);
  }

  return {
    runId: input.runId,
    sessionId: input.sessionId,
    courseKey: input.courseKey,
    status: "running",
    stage: "queued",
    message: "Queued",
    override: input.override,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateRunStage(runId: string, stage: RunRecord["stage"], message?: string): void {
  const now = nowIso();
  getDb()
    .prepare(`UPDATE runs SET stage = ?, message = ?, updated_at = ? WHERE run_id = ?`)
    .run(stage, message ?? null, now, runId);
}

export function updateRunTraces(
  runId: string,
  providerTrace?: ProviderTrace,
  schemaValidationTrace?: SchemaValidationTrace,
): void {
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE runs
       SET provider_trace_json = ?, schema_validation_trace_json = ?, updated_at = ?
       WHERE run_id = ?`,
    )
    .run(toJson(providerTrace), toJson(schemaValidationTrace), now, runId);
}

export function completeRun(runId: string): void {
  const now = nowIso();
  const row = getDb().prepare(`SELECT session_id FROM runs WHERE run_id = ?`).get(runId) as { session_id: string } | undefined;
  if (!row) {
    return;
  }

  getDb()
    .prepare(`UPDATE runs SET status = 'done', stage = 'done', message = 'Completed', updated_at = ? WHERE run_id = ?`)
    .run(now, runId);

  getDb().prepare(`UPDATE sessions SET status = 'done', updated_at = ? WHERE session_id = ?`).run(now, row.session_id);
}

export function failRun(runId: string, message: string): void {
  const now = nowIso();
  const row = getDb().prepare(`SELECT session_id FROM runs WHERE run_id = ?`).get(runId) as { session_id: string } | undefined;
  if (!row) {
    return;
  }

  // Keep the current stage so the UI stepper shows exactly which step failed.
  // Only flip status → 'failed' and persist the error message.
  getDb()
    .prepare(
      `UPDATE runs SET status = 'failed', message = ?, error = ?, updated_at = ? WHERE run_id = ?`,
    )
    .run(message, message, now, runId);

  getDb().prepare(`UPDATE sessions SET status = 'failed', updated_at = ? WHERE session_id = ?`).run(now, row.session_id);
}

export function getRun(runId: string): RunRecord | null {
  const row = getDb()
    .prepare(
      `SELECT run_id, session_id, course_key, status, stage, message, override_json, error,
              provider_trace_json, schema_validation_trace_json, created_at, updated_at
       FROM runs
       WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        run_id: string;
        session_id: string;
        course_key: string;
        status: string;
        stage: string;
        message: string | null;
        override_json: string | null;
        error: string | null;
        provider_trace_json: string | null;
        schema_validation_trace_json: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    runId: row.run_id,
    sessionId: row.session_id,
    courseKey: row.course_key,
    status: row.status as RunRecord["status"],
    stage: row.stage as RunRecord["stage"],
    message: row.message ?? undefined,
    override: fromJson<SessionOverride>(row.override_json) ?? undefined,
    error: row.error ?? undefined,
    providerTrace: fromJson<ProviderTrace>(row.provider_trace_json) ?? undefined,
    schemaValidationTrace: fromJson<SchemaValidationTrace>(row.schema_validation_trace_json) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getLatestRunForSession(sessionId: string): RunRecord | null {
  const row = getDb()
    .prepare(
      `SELECT run_id, session_id, course_key, status, stage, message, override_json, error,
              provider_trace_json, schema_validation_trace_json, created_at, updated_at
       FROM runs
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as
    | {
        run_id: string;
        session_id: string;
        course_key: string;
        status: string;
        stage: string;
        message: string | null;
        override_json: string | null;
        error: string | null;
        provider_trace_json: string | null;
        schema_validation_trace_json: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    runId: row.run_id,
    sessionId: row.session_id,
    courseKey: row.course_key,
    status: row.status as RunRecord["status"],
    stage: row.stage as RunRecord["stage"],
    message: row.message ?? undefined,
    override: fromJson<SessionOverride>(row.override_json) ?? undefined,
    error: row.error ?? undefined,
    providerTrace: fromJson<ProviderTrace>(row.provider_trace_json) ?? undefined,
    schemaValidationTrace: fromJson<SchemaValidationTrace>(row.schema_validation_trace_json) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveAnchor(courseKey: string, sectionId: string, sectionTitle: string): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO anchors(course_key, section_id, section_title, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(course_key) DO UPDATE SET
         section_id = excluded.section_id,
         section_title = excluded.section_title,
         updated_at = excluded.updated_at`,
    )
    .run(courseKey, sectionId, sectionTitle, now);
}

export function getAnchor(courseKey: string): { sectionId: string; sectionTitle: string; updatedAt: string } | null {
  const row = getDb()
    .prepare(`SELECT section_id, section_title, updated_at FROM anchors WHERE course_key = ?`)
    .get(courseKey) as { section_id: string; section_title: string; updated_at: string } | undefined;

  if (!row) {
    return null;
  }

  return {
    sectionId: row.section_id,
    sectionTitle: row.section_title,
    updatedAt: row.updated_at,
  };
}

export function saveResolverDebug(runId: string, sessionId: string, courseKey: string, payload: unknown): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO resolver_debug(run_id, session_id, course_key, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at`,
    )
    .run(runId, sessionId, courseKey, toJson(payload), now);
}

export function getResolverDebug(runId: string): unknown {
  const row = getDb()
    .prepare(`SELECT payload_json FROM resolver_debug WHERE run_id = ?`)
    .get(runId) as { payload_json: string } | undefined;

  if (!row) {
    return null;
  }

  return fromJson<unknown>(row.payload_json);
}

export function replaceMaterials(params: {
  runId: string;
  sessionId: string;
  courseKey: string;
  sectionId: string;
  sectionTitle: string;
  materials: Array<{
    resourceId: string;
    title: string;
    url: string;
    contentHash?: string;
    extractedText?: string;
  }>;
}): void {
  const now = nowIso();
  const tx = getDb().transaction(() => {
    getDb().prepare(`DELETE FROM materials WHERE run_id = ?`).run(params.runId);

    const stmt = getDb().prepare(
      `INSERT INTO materials(
        run_id, session_id, course_key, section_id, section_title,
        resource_id, resource_title, resource_url, content_hash, extracted_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const item of params.materials) {
      stmt.run(
        params.runId,
        params.sessionId,
        params.courseKey,
        params.sectionId,
        params.sectionTitle,
        item.resourceId,
        item.title,
        item.url,
        item.contentHash ?? null,
        item.extractedText ?? null,
        now,
      );
    }
  });

  tx();
}

export function saveSummary(params: {
  runId: string;
  sessionId: string;
  courseKey: string;
  resolverResult: ResolverResult;
  summary: SummaryOutput;
}): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO summaries(run_id, session_id, course_key, resolver_result_json, summary_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         resolver_result_json = excluded.resolver_result_json,
         summary_json = excluded.summary_json,
         created_at = excluded.created_at`,
    )
    .run(params.runId, params.sessionId, params.courseKey, toJson(params.resolverResult), toJson(params.summary), now);
}

export function getSessionDetail(sessionId: string): SessionDetail | null {
  const session = getSession(sessionId);
  if (!session) {
    return null;
  }

  const run = session.lastRunId ? getRun(session.lastRunId) : getLatestRunForSession(sessionId);

  let resolverResult: ResolverResult | null = null;
  let summary: SummaryOutput | null = null;
  if (run) {
    const row = getDb()
      .prepare(`SELECT resolver_result_json, summary_json FROM summaries WHERE run_id = ?`)
      .get(run.runId) as { resolver_result_json: string; summary_json: string } | undefined;
    if (row) {
      resolverResult = fromJson<ResolverResult>(row.resolver_result_json);
      summary = fromJson<SummaryOutput>(row.summary_json);
    }
  }

  const materialRows = run
    ? (getDb()
        .prepare(
          `SELECT resource_id, resource_title, resource_url FROM materials WHERE run_id = ? ORDER BY id ASC`,
        )
        .all(run.runId) as Array<{ resource_id: string; resource_title: string; resource_url: string }>)
    : [];

  return {
    session,
    run,
    resolverResult,
    summary,
    materials: materialRows.map((row) => ({
      resourceId: row.resource_id,
      title: row.resource_title,
      url: row.resource_url,
    })),
  };
}

export function listLatestRuns(limit = 25): RunRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT run_id, session_id, course_key, status, stage, message, override_json, error,
              provider_trace_json, schema_validation_trace_json, created_at, updated_at
       FROM runs
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    run_id: string;
    session_id: string;
    course_key: string;
    status: string;
    stage: string;
    message: string | null;
    override_json: string | null;
    error: string | null;
    provider_trace_json: string | null;
    schema_validation_trace_json: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    runId: row.run_id,
    sessionId: row.session_id,
    courseKey: row.course_key,
    status: row.status as RunRecord["status"],
    stage: row.stage as RunRecord["stage"],
    message: row.message ?? undefined,
    override: fromJson<SessionOverride>(row.override_json) ?? undefined,
    error: row.error ?? undefined,
    providerTrace: fromJson<ProviderTrace>(row.provider_trace_json) ?? undefined,
    schemaValidationTrace: fromJson<SchemaValidationTrace>(row.schema_validation_trace_json) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getLastSessionForCourseOnDate(courseKey: string, date: string): SessionRecord | null {
  const row = getDb()
    .prepare(
      `SELECT session_id, course_key, course_name, date, event_title, session_label, status, created_at, updated_at, last_run_id
       FROM sessions
       WHERE course_key = ? AND date = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(courseKey, date) as
    | {
        session_id: string;
        course_key: string;
        course_name: string;
        date: string;
        event_title: string;
        session_label: string | null;
        status: string;
        created_at: string;
        updated_at: string;
        last_run_id: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    sessionId: row.session_id,
    courseKey: row.course_key,
    courseName: row.course_name,
    date: row.date,
    eventTitle: row.event_title,
    sessionLabel: row.session_label ?? undefined,
    status: row.status as SessionRecord["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id ?? undefined,
  };
}

/**
 * Remove stale sessions for the same course+date that have a different session_id.
 * This cleans up old hex-UID rows that accumulate when the session-ID hashing
 * scheme changed, keeping only the canonical session.
 */
export function cleanupStaleSessionsForCourseDate(courseKey: string, date: string, keepSessionId: string): void {
  getDb()
    .prepare(
      `DELETE FROM sessions
       WHERE course_key = ?
         AND date = ?
         AND session_id != ?
         AND session_id NOT LIKE '%-manual-%'`,
    )
    .run(courseKey, date, keepSessionId);
}

export function getDbPath(): string {
  return path.resolve(config.dbPath);
}
