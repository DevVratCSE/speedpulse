export type Strategy =
  | "mobile"
  | "desktop";


export type Frequency =
  | "daily"
  | "weekly"
  | "manual";


export type RunSource =
  | "manual"
  | "scheduled";


export type CruxProviderStatus =
  | "available"
  | "no_record"
  | "provider_error";


export type DetailedReportDetailLevel =
  | "compact"
  | "summary";

export type ReportStorageBackend =
  | "d1"
  | "r2"
  | "kv";


export interface Env {
  DB: D1Database;

  SCAN_QUEUE: Queue<{
    jobId: number;
    siteId: number;
    strategy: Strategy;
  }>;

  /*
   * Workers KV namespace.
   *
   * No R2 subscription or billing activation is required.
   */
  REPORTS: KVNamespace;
  R2_REPORTS?: {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    put(key: string, value: string, options?: unknown): Promise<unknown>;
    delete(key: string): Promise<void>;
  };
  REPORT_STORAGE?: ReportStorageBackend | string;

  ASSETS: Fetcher;

  GOOGLE_API_KEY?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;

  /** @deprecated Legacy scheduler removed; use NEXT_SCHEDULER_BATCH_SIZE */
  SCHEDULE_BATCH_SIZE?: string;
  CRON_SCHEDULE?: string;

  APP_ENV?: string;

  /** @deprecated Legacy scheduler removed; Next scheduler is sole scheduler */
  LEGACY_SCHEDULER_ENABLED?: string;

  NEXT_SCHEDULER_ENABLED?: string;
  NEXT_SCHEDULER_MODE?: string;
  NEXT_SCHEDULER_BATCH_SIZE?: string;
  NEXT_SCHEDULER_DAILY_BUDGET?: string;

  QUEUE_SCANS_ENABLED?: string;

  DETAILED_REPORTS_ENABLED?: string;
  DETAILED_REPORTS_DAILY_WRITE_BUDGET?: string;
  DETAILED_REPORTS_DAILY_DELETE_BUDGET?: string;
  DETAILED_REPORTS_CLEANUP_PER_CRON?: string;
}


export interface SiteRow {
  id: number;
  project_id: number;
  name: string;
  url: string;
  origin: string;
  active: number;

  mobile_frequency: Frequency;
  desktop_frequency: Frequency;

  mobile_next_check_at:
    | string
    | null;

  desktop_next_check_at:
    | string
    | null;
}


export interface PsiResult {
  analysisTime: string;
  finalUrl: string;

  lighthouseVersion:
    | string
    | null;

  fetchTime:
    | string
    | null;

  performance:
    | number
    | null;

  accessibility:
    | number
    | null;

  seo:
    | number
    | null;

  bestPractices:
    | number
    | null;

  fcpMs:
    | number
    | null;

  lcpMs:
    | number
    | null;

  tbtMs:
    | number
    | null;

  cls:
    | number
    | null;

  speedIndexMs:
    | number
    | null;
}


export interface PageSpeedFetchResult {
  summary: PsiResult;

  detailedReportJson: string;

  detailedReportBytes: number;

  detailedReportLevel:
    DetailedReportDetailLevel;
}


export interface CruxResult {
  available: boolean;

  source:
    | "crux-origin"
    | null;

  lcpMs:
    | number
    | null;

  inpMs:
    | number
    | null;

  cls:
    | number
    | null;

  periodStart:
    | string
    | null;

  periodEnd:
    | string
    | null;
}


export interface CruxFetchResult {
  summary: CruxResult;

  providerStatus:
    CruxProviderStatus;

  httpStatus:
    | number
    | null;

  error:
    | string
    | null;
}


export interface MetricsDailyRollupRow {
  id: number;
  site_id: number;
  strategy: Strategy;
  rollup_date: string;
  recorded_at: string;
  total_runs: number;
  successful_runs: number;
  performance_score: number | null;
  accessibility_score: number | null;
  seo_score: number | null;
  best_practices_score: number | null;
  performance_score_p75: number | null;
  accessibility_score_p75: number | null;
  seo_score_p75: number | null;
  best_practices_score_p75: number | null;
  fcp_ms: number | null;
  lcp_ms: number | null;
  tbt_ms: number | null;
  cls: number | null;
  speed_index_ms: number | null;
  fcp_ms_p75: number | null;
  lcp_ms_p75: number | null;
  tbt_ms_p75: number | null;
  cls_p75: number | null;
  speed_index_ms_p75: number | null;
  field_lcp_ms: number | null;
  field_inp_ms: number | null;
  field_cls: number | null;
  field_data_source: string | null;
  created_at: string;
  updated_at: string;
}

export interface RetentionPruneResult {
  metricsPruned: number;
  runsPruned: number;
  jobsPruned: number;
  cutoff: string;
}
