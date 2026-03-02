export type PipelineStatus = "queued" | "running" | "done" | "failed";

export type PipelineStage =
  | "queued"
  | "resolving"
  | "downloading"
  | "parsing"
  | "summarizing"
  | "writing"
  | "done"
  | "failed";

export interface Session {
  sessionId: string;
  courseName: string;
  courseKey: string;
  eventTitle: string;
  date: string;
  sessionLabel?: string;
}

export interface SessionOverride {
  sectionId?: string;
  topicNumber?: number;
  contains?: string;
  persistAsAnchor?: boolean;
}

export interface ScheduleEvent {
  id: string;
  courseName: string;
  title: string;
  date: string;
  topicLabel?: string;
}

export type ResourceType = "pdf" | "ppt" | "doc" | "xlsx" | "link" | "video" | "other";

export interface CourseResource {
  id: string;
  title: string;
  type: ResourceType;
  url: string;
  mimetype?: string;
  uploadedAt?: string;
  orderIndex?: number;
}

export interface CourseSection {
  id: string;
  title: string;
  resources: CourseResource[];
}

export interface MoodleCourse {
  id: string;
  name: string;
  slug?: string;
  url?: string;
  sections: CourseSection[];
}

export interface MaterialLink {
  id: string;
  title: string;
  url: string;
  type: "pdf" | "ppt";
  uploadedAt?: string;
  orderIndex?: number;
}

export interface ResolverScore {
  sectionId: string;
  sectionTitle: string;
  score: number;
  reasons: string[];
  pdfCount: number;
}

export type OverrideApplied = "sectionId" | "topicNumber" | "contains" | "anchor" | "automatic";

export interface ResolverDebug {
  allSections: ResolverScore[];
  overrideApplied: OverrideApplied;
  confidenceScore: number;
  selectedReason: string;
  navigationSteps?: string[];
  domStats?: {
    sectionCount: number;
    resourceCount: number;
    pdfResources: number;
    pptResources: number;
  };
  pdfFilterStats?: {
    inputResources: number;
    pdfResources: number;
    pptResources: number;
    selectedResources: number;
  };
  htmlSnapshot?: string;
  failureReason?: string;
}

export interface ResolverResult {
  selectedSectionId: string;
  selectedSectionTitle: string;
  pdfLinks: MaterialLink[];
  debug: ResolverDebug;
}

export interface ParsedPdf {
  resourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  text: string;
}

export interface TextChunk {
  chunkId: string;
  resourceId: string;
  sourceTitle: string;
  order: number;
  text: string;
}

export interface SummaryOutput {
  layer1KeyConcepts: string[];
  layer2StructuredExplanation: Array<{ heading: string; points: string[] }>;
  layer3DetailedNotes: string[];
  preparationTips?: string[];
  keyEquationsOrDefinitions?: string[];
}

export type SummaryProviderMode = "auto" | "gemini" | "chatpdf" | "deterministic";

export interface SchemaValidationTrace {
  attempts: number;
  repairedAttempts: number;
  providerPayloadErrors: string[];
}

export interface ProviderTrace {
  requestedProvider: SummaryProviderMode;
  finalProvider: "gemini" | "chatpdf" | "deterministic";
  attempts: Array<{
    provider: "gemini" | "chatpdf" | "deterministic";
    ok: boolean;
    reason?: string;
  }>;
  fallbackReason?: string;
}

export interface SessionRecord extends Session {
  status: PipelineStatus;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
}

export interface RunRecord {
  runId: string;
  sessionId: string;
  courseKey: string;
  status: PipelineStatus;
  stage: PipelineStage;
  message?: string;
  override?: SessionOverride;
  error?: string;
  providerTrace?: ProviderTrace;
  schemaValidationTrace?: SchemaValidationTrace;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail {
  session: SessionRecord;
  run: RunRecord | null;
  resolverResult: ResolverResult | null;
  summary: SummaryOutput | null;
  materials: Array<{ resourceId: string; title: string; url: string }>;
}

export interface BacktestResult {
  session: Session;
  runId: string;
  status: PipelineStatus;
  selectedSectionId?: string;
  selectedSectionTitle?: string;
  pdfCount: number;
  summaryLength: number;
  error?: string;
}
