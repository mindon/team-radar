import {
  DIMENSION_KEYS,
  ManagementProfile,
  StructuredReview,
  TeamPublicView,
  TeamRecord,
} from "./types.ts";

const VECTOR_SIZE = 64;

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function normalizeOrgPart(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${fieldName}`);
  const normalized = value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  if (normalized.length < 2 || normalized.length > 120) throw new Error(`Invalid ${fieldName}`);
  return normalized;
}

export function normalizeFreeText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid raw_content");
  const normalized = value.trim().split(String.fromCharCode(0)).join("");
  if (normalized.length < 20) throw new Error("raw_content is too short");
  if (normalized.length > 4000) throw new Error("raw_content is too long");
  return normalized;
}

export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function emptyProfile(value = 0): ManagementProfile {
  return Object.fromEntries(DIMENSION_KEYS.map((key) => [key, value])) as ManagementProfile;
}

export function clampScore(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) throw new Error("Invalid dimension score");
  return Math.min(10, Math.max(1, Math.round(numberValue * 10) / 10));
}

export function validateStructuredReview(input: unknown): StructuredReview {
  if (!input || typeof input !== "object") throw new Error("Invalid LLM result");
  const record = input as Record<string, unknown>;
  const dimensions = record.dimensions as Record<string, unknown> | undefined;
  if (!dimensions || typeof dimensions !== "object") throw new Error("Missing dimensions");

  const normalizedDimensions = emptyProfile();
  for (const key of DIMENSION_KEYS) normalizedDimensions[key] = clampScore(dimensions[key]);

  const rawTags = Array.isArray(record.extracted_tags) ? record.extracted_tags : [];
  const extractedTags = [
    ...new Set(
      rawTags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length >= 2 && tag.length <= 16),
    ),
  ]
    .slice(0, 5);

  if (extractedTags.length === 0) throw new Error("Missing extracted_tags");

  if (typeof record.safe_summary !== "string") throw new Error("Missing safe_summary");
  const safeSummary = record.safe_summary.trim().replace(/\s+/g, " ");
  if (safeSummary.length < 12 || safeSummary.length > 180) throw new Error("Invalid safe_summary");

  return {
    dimensions: normalizedDimensions,
    extracted_tags: extractedTags,
    safe_summary: safeSummary,
  };
}

export function parseModelJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed);
}

export function addProfiles(a: ManagementProfile, b: ManagementProfile): ManagementProfile {
  const result = emptyProfile();
  for (const key of DIMENSION_KEYS) result[key] = a[key] + b[key];
  return result;
}

export function averageProfile(sum: ManagementProfile, count: number): ManagementProfile {
  const result = emptyProfile();
  for (const key of DIMENSION_KEYS) {
    result[key] = Math.round((sum[key] / Math.max(1, count)) * 10) / 10;
  }
  return result;
}

function laplaceNoise(scale: number): number {
  const u = Math.random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

export function privacySnapshot(mean: ManagementProfile, count: number): ManagementProfile {
  const result = emptyProfile();
  const scale = Math.min(0.35, 0.9 / Math.sqrt(Math.max(3, count)));
  for (const key of DIMENSION_KEYS) result[key] = clampScore(mean[key] + laplaceNoise(scale));
  return result;
}

export function textEmbedding(text: string): number[] {
  const vector = Array.from({ length: VECTOR_SIZE }, () => 0);
  const normalized = text.toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");

  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    const next = normalized.charCodeAt(i + 1) || 17;
    const index = (code * 31 + next * 17 + i) % VECTOR_SIZE;
    vector[index] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / ((Math.sqrt(normA) * Math.sqrt(normB)) || 1);
}

export function mergeEmbeddings(
  previous: number[],
  next: number[],
  previousCount: number,
): number[] {
  if (previous.length === 0) return next;
  return previous.map((value, index) =>
    ((value * previousCount) + (next[index] ?? 0)) / (previousCount + 1)
  );
}

export function toPublicWeekBucket(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function publicTeamView(team: TeamRecord, matchScore?: number): TeamPublicView | null {
  if (team.status !== "active" || team.review_count < 3) return null;
  const tags = Object.entries(team.tag_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag]) => tag);

  return {
    team_id: team.team_id,
    group_name: team.group_name,
    dept_path: team.dept_path,
    manager_shadow_id: team.manager_shadow_id,
    status: "active",
    review_count: team.review_count,
    metrics_snapshot: team.metrics_snapshot,
    tags,
    safe_summaries: team.safe_summaries.slice(-3),
    updated_at: team.updated_at,
    latest_timeline_at: toPublicWeekBucket(team.updated_at),
    match_score: matchScore === undefined ? undefined : Math.round(matchScore * 1000) / 1000,
  };
}
