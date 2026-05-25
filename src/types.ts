export const DIMENSION_KEYS = [
  "transparency",
  "autonomy",
  "psychological_safety",
  "feedback_loop",
  "wlb_boundary",
  "growth_support",
] as const;

export type DimensionKey = typeof DIMENSION_KEYS[number];

export type ManagementProfile = Record<DimensionKey, number>;

export interface StructuredReview {
  dimensions: ManagementProfile;
  extracted_tags: string[];
  safe_summary: string;
}

export interface TeamRecord {
  team_id: string;
  group_name: string;
  dept_path: string;
  manager_shadow_id: string;
  status: "shadow" | "active" | "archived";
  review_count: number;
  metrics_snapshot: ManagementProfile;
  metrics_raw_sum: ManagementProfile;
  embedding: number[];
  tag_counts: Record<string, number>;
  safe_summaries: string[];
  created_at: string;
  updated_at: string;
}

export interface ReviewBufferRecord extends StructuredReview {
  review_id: string;
  team_id: string;
  status: "pending_process" | "merged" | "purged";
  publish_at: number;
  created_at: string;
}

export interface IngestPayload {
  raw_content?: unknown;
  group_name?: unknown;
  dept_path?: unknown;
  email?: unknown;
}

export interface TeamMajorEvent {
  id: string;
  team_id: string;
  occurred_at: string;
  recorded_at: string;
  brief: string;
  source_timeline_id: string;
  review_count: number;
  metrics_snapshot: ManagementProfile;
  tags: string[];
  source_title?: string;
  source_url?: string;
  event_type?: PublicEventType;
  event_fingerprint?: string;
  confidence?: number;
  confirmed_by?: "agent" | "auto" | "manual";
  confirm_reason?: string;
  collector_candidate_id?: string;
}

export interface TeamTimelinePoint {
  id: string;
  team_id: string;
  at: string; // public weekly bucket, e.g. 2026-W20
  event: "activated" | "review_merged" | "seed_snapshot";
  review_count: number;
  metrics_snapshot: ManagementProfile;
  tags: string[];
  safe_summary: string;
  major_event_count: number;
}

export type PublicEventSourceTrust =
  | "official"
  | "primary_public"
  | "reputable_media"
  | "community";

export type PublicEventType =
  | "launch"
  | "release"
  | "deprecation"
  | "migration"
  | "roadmap"
  | "strategy"
  | "reorg"
  | "hiring"
  | "layoff"
  | "infrastructure"
  | "other";

export interface PublicEventSource {
  id: string;
  name: string;
  kind: "rss" | "html";
  url: string;
  trust_level?: PublicEventSourceTrust;
  domain_allowlist?: string[];
  auto_confirm?: boolean;
  group_hints: string[];
  team_hints: string[];
}

export interface KnownTeamSeed {
  slug: string;
  group_name: string;
  dept_path: string;
  team_alias: string;
  team_hints: string[];
  public_sources: string[];
}

export interface KnownTeamRecord extends KnownTeamSeed {
  team_id: string;
  contribution_path: string;
  created_at: string;
  updated_at: string;
}

export interface PublicEventEvidence {
  source_id: string;
  source_name: string;
  title: string;
  url: string;
  fetched_at: string;
}

export interface PublicEventCandidate {
  id: string;
  source_id: string;
  source_name: string;
  source_url: string;
  source_title: string;
  source_item_url: string;
  source_trust_level: PublicEventSourceTrust;
  source_auto_confirm: boolean;
  occurred_at: string;
  brief: string;
  matched_group: string;
  matched_team_hint: string;
  suggested_team_id?: string;
  suggested_team_slug?: string;
  suggested_team_label?: string;
  match_confidence?: number;
  event_type: PublicEventType;
  event_fingerprint: string;
  confidence: number;
  evidence: PublicEventEvidence[];
  status:
    | "candidate"
    | "needs_review"
    | "needs_evidence"
    | "agent_confirmed"
    | "agent_dismissed"
    | "auto_confirmed"
    | "confirmed"
    | "dismissed";
  created_at: string;
  confirmed_at?: string;
  confirmed_by?: "agent" | "auto" | "manual";
  confirmed_team_id?: string;
  confirm_reason?: string;
  published_event_id?: string;
}

export interface TeamPublicView {
  team_id: string;
  group_name: string;
  dept_path: string;
  manager_shadow_id: string;
  status: "active";
  review_count: number;
  metrics_snapshot: ManagementProfile;
  tags: string[];
  safe_summaries: string[];
  updated_at: string;
  latest_timeline_at?: string;
  match_score?: number;
}

export interface SearchParams {
  query?: string;
  group_name?: string;
  tag?: string;
  limit?: number;
}
