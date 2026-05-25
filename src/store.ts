import {
  IngestPayload,
  ManagementProfile,
  ReviewBufferRecord,
  SearchParams,
  StructuredReview,
  TeamMajorEvent,
  TeamPublicView,
  TeamRecord,
  TeamTimelinePoint,
} from "./types.ts";
import {
  addProfiles,
  averageProfile,
  cosineSimilarity,
  emptyProfile,
  mergeEmbeddings,
  normalizeOrgPart,
  privacySnapshot,
  publicTeamView,
  sha256Hex,
  textEmbedding,
  toPublicWeekBucket,
} from "./utils.ts";

export const kv = await Deno.openKv();

const DEFAULT_MIN_DELAY_DAYS = 3;
const DEFAULT_MAX_DELAY_DAYS = 14;

function delayDays(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function randomDelayMs(): number {
  const minDays = delayDays("REVIEW_MIN_DELAY_DAYS", DEFAULT_MIN_DELAY_DAYS);
  const maxDays = Math.max(minDays, delayDays("REVIEW_MAX_DELAY_DAYS", DEFAULT_MAX_DELAY_DAYS));
  const days = minDays + Math.random() * (maxDays - minDays);
  return Math.round(days * 24 * 60 * 60 * 1000);
}

function normalizeMajorEventAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toUpperCase();
  if (/^\d{4}-\d{2}$/.test(normalized)) return normalized;
  if (/^\d{4}-W\d{2}$/.test(normalized)) return normalized;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  throw new Error("Invalid major_event_at");
}

function publicTimeSortKey(value: string): number {
  const week = value.match(/^(\d{4})-W(\d{2})$/);
  if (week) {
    const year = Number(week[1]);
    const weekNo = Number(week[2]);
    return Date.UTC(year, 0, 1 + (weekNo - 1) * 7);
  }

  const month = value.match(/^(\d{4})-(\d{2})$/);
  if (month) return Date.UTC(Number(month[1]), Number(month[2]) - 1, 1);

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventMatchesWeek(eventAt: string, weekBucket: string): boolean {
  const normalized = eventAt.toUpperCase();
  const week = weekBucket.toUpperCase();
  if (/^\d{4}-W\d{2}$/.test(normalized)) return normalized === week;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return toPublicWeekBucket(normalized) === week;
  if (/^\d{4}-\d{2}$/.test(normalized)) return toPublicWeekBucket(normalized + "-15") === week;
  return false;
}

function sanitizeMajorEventBrief(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const redacted = value.trim()
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[邮箱]")
    .replace(/1[3-9]\d{9}/g, "[手机号]")
    .replace(/(?:微信|wx|wechat)[:：]?\s*[\w-]{4,}/gi, "[联系方式]")
    .replace(/\s+/g, " ");
  if (redacted.length < 6) return undefined;
  return redacted.slice(0, 120);
}

function sanitizeAuditText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().replace(/[^\p{L}\p{N}_.:|/ -]/gu, "").replace(/\s+/g, " ").slice(
    0,
    maxLength,
  );
}

export async function resolveTeamId(groupName: string, deptPath: string): Promise<string> {
  const deptHash = await sha256Hex(`${groupName}:${deptPath}`);
  const indexKey: Deno.KvKey = ["team_by_org", groupName, deptHash];
  const existing = await kv.get<string>(indexKey);
  if (existing.value) return existing.value;

  const teamId = crypto.randomUUID();
  const now = new Date().toISOString();
  const team: TeamRecord = {
    team_id: teamId,
    group_name: groupName,
    dept_path: deptPath,
    manager_shadow_id: `MGR-${teamId.slice(0, 8).toUpperCase()}`,
    status: "shadow",
    review_count: 0,
    metrics_snapshot: emptyProfile(),
    metrics_raw_sum: emptyProfile(),
    embedding: [],
    tag_counts: {},
    safe_summaries: [],
    created_at: now,
    updated_at: now,
  };

  const commit = await kv.atomic()
    .check(existing)
    .set(["team", teamId], team)
    .set(indexKey, teamId)
    .commit();

  if (commit.ok) return teamId;

  const afterRace = await kv.get<string>(indexKey);
  if (!afterRace.value) throw new Error("Failed to resolve team id");
  return afterRace.value;
}

export async function persistBufferedReview(
  payload: IngestPayload,
  structuredData: StructuredReview,
): Promise<{ team_id: string; review_id: string; publish_at: number }> {
  const groupName = normalizeOrgPart(payload.group_name, "group_name");
  const deptPath = normalizeOrgPart(payload.dept_path, "dept_path");
  const teamId = await resolveTeamId(groupName, deptPath);
  const reviewId = crypto.randomUUID();
  const publishAt = Date.now() + randomDelayMs();
  const now = new Date().toISOString();

  const record: ReviewBufferRecord = {
    review_id: reviewId,
    team_id: teamId,
    dimensions: structuredData.dimensions,
    extracted_tags: structuredData.extracted_tags,
    safe_summary: structuredData.safe_summary,
    status: "pending_process",
    publish_at: publishAt,
    created_at: now,
  };

  const commit = await kv.atomic()
    .set(["review_buffer", publishAt, reviewId], record)
    .set(["review_by_team", teamId, reviewId], { status: "pending_process", publish_at: publishAt })
    .commit();

  if (!commit.ok) throw new Error("Failed to persist review buffer");

  await kv.enqueue({ type: "publish_review", publish_at: publishAt, review_id: reviewId }, {
    delay: Math.max(0, publishAt - Date.now()),
  });

  return { team_id: teamId, review_id: reviewId, publish_at: publishAt };
}

function topTags(tagCounts: Record<string, number>): string[] {
  return Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag]) => tag);
}

function createTimelinePoint(
  team: TeamRecord,
  event: TeamTimelinePoint["event"],
  safeSummary: string,
  id: string = crypto.randomUUID(),
): TeamTimelinePoint {
  return {
    id,
    team_id: team.team_id,
    at: toPublicWeekBucket(team.updated_at),
    event,
    review_count: team.review_count,
    metrics_snapshot: team.metrics_snapshot,
    tags: topTags(team.tag_counts).slice(0, 6),
    safe_summary: safeSummary,
    major_event_count: 0,
  };
}

function sanitizeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid source_url");
  return url.toString();
}

function sanitizeSourceTitle(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

async function publishReview(record: ReviewBufferRecord): Promise<boolean> {
  if (record.status !== "pending_process") return false;

  const teamEntry = await kv.get<TeamRecord>(["team", record.team_id]);
  if (!teamEntry.value) return false;

  const previous = teamEntry.value;
  const nextCount = previous.review_count + 1;
  const nextRawSum = addProfiles(previous.metrics_raw_sum, record.dimensions);
  const mean = averageProfile(nextRawSum, nextCount);
  const nextTags = { ...previous.tag_counts };
  for (const tag of record.extracted_tags) nextTags[tag] = (nextTags[tag] ?? 0) + 1;

  const nextTeam: TeamRecord = {
    ...previous,
    status: nextCount >= 3 ? "active" : "shadow",
    review_count: nextCount,
    metrics_raw_sum: nextRawSum,
    metrics_snapshot: nextCount >= 3 ? privacySnapshot(mean, nextCount) : emptyProfile(),
    embedding: mergeEmbeddings(
      previous.embedding,
      textEmbedding(record.safe_summary),
      previous.review_count,
    ),
    tag_counts: nextTags,
    safe_summaries: [...previous.safe_summaries, record.safe_summary].slice(-10),
    updated_at: new Date().toISOString(),
  };

  const mergedRecord: ReviewBufferRecord = { ...record, status: "merged" };
  let atomic = kv.atomic()
    .check(teamEntry)
    .set(["team", record.team_id], nextTeam)
    .set(["review_buffer", record.publish_at, record.review_id], mergedRecord)
    .set(["review_by_team", record.team_id, record.review_id], {
      status: "merged",
      publish_at: record.publish_at,
    });

  if (nextTeam.status === "active") {
    const event: TeamTimelinePoint["event"] = previous.status === "active"
      ? "review_merged"
      : "activated";
    const point = createTimelinePoint(nextTeam, event, record.safe_summary, record.review_id);
    atomic = atomic.set(["team_timeline", record.team_id, publicTimeSortKey(point.at)], point);

    for (const tag of topTags(nextTeam.tag_counts)) {
      atomic = atomic.set(["tag_index", tag, record.team_id], {
        score: nextTeam.tag_counts[tag],
        updated_at: nextTeam.updated_at,
      });
    }
  }

  const commit = await atomic.commit();
  return commit.ok;
}

export async function processDueReviews(
  now = Date.now(),
): Promise<{ processed: number; skipped: number }> {
  let processed = 0;
  let skipped = 0;

  for await (const entry of kv.list<ReviewBufferRecord>({ prefix: ["review_buffer"] })) {
    const publishAt = Number(entry.key[1]);
    if (Number.isFinite(publishAt) && publishAt > now) break;
    const ok = await publishReview(entry.value);
    if (ok) processed++;
    else skipped++;
  }

  return { processed, skipped };
}

export async function listPublicTeams(params: SearchParams = {}): Promise<TeamPublicView[]> {
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 50);
  const cacheKey = await sha256Hex(JSON.stringify(params));
  const cached = await kv.get<TeamPublicView[]>(["search_cache", cacheKey]);
  if (cached.value) return cached.value;

  const queryEmbedding = params.query?.trim() ? textEmbedding(params.query) : undefined;
  const groupName = params.group_name
    ? normalizeOrgPart(params.group_name, "group_name")
    : undefined;
  const tag = params.tag?.trim();
  const candidates = new Map<string, number>();

  if (tag) {
    for await (const entry of kv.list<{ score: number }>({ prefix: ["tag_index", tag] })) {
      const teamId = String(entry.key[2]);
      candidates.set(teamId, entry.value.score ?? 1);
    }
  }

  const views: TeamPublicView[] = [];
  const sourceIds = candidates.size > 0 ? [...candidates.keys()] : undefined;

  if (sourceIds) {
    for (const teamId of sourceIds) {
      const team = await kv.get<TeamRecord>(["team", teamId]);
      if (!team.value) continue;
      if (groupName && team.value.group_name !== groupName) continue;
      const score = queryEmbedding
        ? cosineSimilarity(queryEmbedding, team.value.embedding)
        : candidates.get(teamId);
      const view = publicTeamView(team.value, score);
      if (view) views.push(view);
    }
  } else {
    for await (const entry of kv.list<TeamRecord>({ prefix: ["team"] })) {
      if (groupName && entry.value.group_name !== groupName) continue;
      const score = queryEmbedding
        ? cosineSimilarity(queryEmbedding, entry.value.embedding)
        : undefined;
      const view = publicTeamView(entry.value, score);
      if (view) views.push(view);
    }
  }

  views.sort((a, b) => {
    if (queryEmbedding || tag) return (b.match_score ?? 0) - (a.match_score ?? 0);
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });

  const result = views.slice(0, limit);
  await kv.set(["search_cache", cacheKey], result, { expireIn: 5 * 60 * 1000 });
  return result;
}

export async function getPublicTeam(teamId: string): Promise<TeamPublicView | null> {
  const entry = await kv.get<TeamRecord>(["team", teamId]);
  return entry.value ? publicTeamView(entry.value) : null;
}

export async function getTeamTimeline(
  teamId: string,
  limit = 24,
): Promise<TeamTimelinePoint[]> {
  const team = await getPublicTeam(teamId);
  if (!team) return [];

  const pointsByWeek = new Map<string, TeamTimelinePoint>();
  for await (const entry of kv.list<TeamTimelinePoint>({ prefix: ["team_timeline", teamId] })) {
    const publicAt = /^\d{4}-W\d{2}$/i.test(entry.value.at)
      ? entry.value.at.toUpperCase()
      : toPublicWeekBucket(entry.value.at);
    const point = { ...entry.value, at: publicAt };
    const existing = pointsByWeek.get(publicAt);
    if (!existing || point.review_count >= existing.review_count) pointsByWeek.set(publicAt, point);
  }

  const events: TeamMajorEvent[] = [];
  for await (const entry of kv.list<TeamMajorEvent>({ prefix: ["team_major_event", teamId] })) {
    events.push(entry.value);
  }

  return [...pointsByWeek.values()]
    .map((point) => ({
      ...point,
      major_event_count:
        events.filter((event) => eventMatchesWeek(event.occurred_at, point.at)).length,
    }))
    .sort((a, b) => publicTimeSortKey(b.at) - publicTimeSortKey(a.at))
    .slice(0, Math.min(Math.max(limit, 1), 100));
}

export async function getTeamMajorEvents(
  teamId: string,
  limit = 24,
): Promise<TeamMajorEvent[]> {
  const team = await getPublicTeam(teamId);
  if (!team) return [];

  const events: TeamMajorEvent[] = [];
  for await (const entry of kv.list<TeamMajorEvent>({ prefix: ["team_major_event", teamId] })) {
    events.push(entry.value);
  }

  return events
    .sort((a, b) => publicTimeSortKey(b.occurred_at) - publicTimeSortKey(a.occurred_at))
    .slice(0, Math.min(Math.max(limit, 1), 100));
}

export async function recordPublicMajorEvent(
  teamId: string,
  payload: Record<string, unknown>,
): Promise<TeamMajorEvent> {
  const teamEntry = await kv.get<TeamRecord>(["team", teamId]);
  if (!teamEntry.value || teamEntry.value.status !== "active") throw new Error("Team not found");

  const occurredAt = normalizeMajorEventAt(payload.occurred_at);
  const brief = sanitizeMajorEventBrief(payload.brief);
  if (!occurredAt || !brief) throw new Error("Invalid public major event");

  const sourceTitle = sanitizeSourceTitle(payload.source_title);
  const sourceUrl = sanitizeSourceUrl(payload.source_url);
  if (!sourceTitle && !sourceUrl) throw new Error("Missing public source");

  const team = teamEntry.value;
  const event: TeamMajorEvent = {
    id: crypto.randomUUID(),
    team_id: teamId,
    occurred_at: occurredAt,
    recorded_at: new Date().toISOString(),
    brief,
    source_timeline_id: toPublicWeekBucket(occurredAt),
    review_count: team.review_count,
    metrics_snapshot: team.metrics_snapshot,
    tags: topTags(team.tag_counts).slice(0, 6),
    source_title: sourceTitle,
    source_url: sourceUrl,
    event_type: sanitizeAuditText(payload.event_type, 32) as TeamMajorEvent["event_type"],
    event_fingerprint: sanitizeAuditText(payload.event_fingerprint, 96),
    confidence: typeof payload.confidence === "number"
      ? Math.round(Math.min(1, Math.max(0, payload.confidence)) * 1000) / 1000
      : undefined,
    confirmed_by: payload.confirmed_by === "agent" || payload.confirmed_by === "auto" ||
        payload.confirmed_by === "manual"
      ? payload.confirmed_by
      : undefined,
    confirm_reason: sanitizeAuditText(payload.confirm_reason, 120),
    collector_candidate_id: sanitizeAuditText(payload.collector_candidate_id, 96),
  };

  await kv.set(["team_major_event", teamId, publicTimeSortKey(event.occurred_at), event.id], event);
  return event;
}

export async function grantAccess(
  email: unknown,
): Promise<{ email_hash: string; expires_at: string }> {
  if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    throw new Error("Invalid email");
  }
  const salt = Deno.env.get("EMAIL_HASH_SALT") ?? "teamradar-local-salt";
  const emailHash = await sha256Hex(`${email.trim().toLocaleLowerCase("en-US")}:${salt}`);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await kv.set(["access_grant", emailHash], {
    expires_at: expiresAt,
    quota: 100,
    created_at: new Date().toISOString(),
  }, { expireIn: 7 * 24 * 60 * 60 * 1000 });
  return { email_hash: emailHash, expires_at: expiresAt };
}

export async function upsertSeedTeam(input: {
  group_name: string;
  dept_path: string;
  manager_shadow_id: string;
  metrics_snapshot: ManagementProfile;
  tags: string[];
  summaries: string[];
  major_events?: Array<{
    occurred_at: string;
    brief: string;
    source_title?: string;
    source_url?: string;
  }>;
}): Promise<string> {
  const groupName = normalizeOrgPart(input.group_name, "group_name");
  const dept = normalizeOrgPart(input.dept_path, "dept_path");
  const teamId = await resolveTeamId(groupName, dept);
  const now = new Date().toISOString();
  const tagCounts = Object.fromEntries(input.tags.map((tag) => [tag, 3])) as Record<string, number>;
  const team: TeamRecord = {
    team_id: teamId,
    group_name: groupName,
    dept_path: dept,
    manager_shadow_id: input.manager_shadow_id,
    status: "active",
    review_count: 5,
    metrics_snapshot: input.metrics_snapshot,
    metrics_raw_sum: Object.fromEntries(
      Object.entries(input.metrics_snapshot).map(([key, value]) => [key, value * 5]),
    ) as ManagementProfile,
    embedding: textEmbedding(`${input.tags.join(" ")} ${input.summaries.join(" ")}`),
    tag_counts: tagCounts,
    safe_summaries: input.summaries,
    created_at: now,
    updated_at: now,
  };

  let atomic = kv.atomic().set(["team", teamId], team);
  for (const tag of input.tags) {
    atomic = atomic.set(["tag_index", tag, teamId], { score: 3, updated_at: now });
  }

  const baseTime = Date.now() - 21 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < 3; index++) {
    const at = new Date(baseTime + index * 7 * 24 * 60 * 60 * 1000).toISOString();
    const ratio = (index + 1) / 3;
    const point: TeamTimelinePoint = {
      ...createTimelinePoint(
        {
          ...team,
          review_count: 3 + index,
          metrics_snapshot: Object.fromEntries(
            Object.entries(input.metrics_snapshot).map(([key, value]) => [
              key,
              Math.round((Math.max(1, value - (1 - ratio) * 0.8)) * 10) / 10,
            ]),
          ) as ManagementProfile,
          updated_at: at,
        },
        index === 0 ? "activated" : "seed_snapshot",
        input.summaries[index % input.summaries.length],
        `seed-${index + 1}`,
      ),
    };
    point.at = toPublicWeekBucket(at);
    atomic = atomic.set(["team_timeline", teamId, publicTimeSortKey(point.at), point.id], point);
  }

  for (const [index, event] of (input.major_events ?? []).entries()) {
    const occurredAt = normalizeMajorEventAt(event.occurred_at);
    const brief = sanitizeMajorEventBrief(event.brief);
    if (!occurredAt || !brief) continue;
    const majorEvent: TeamMajorEvent = {
      id: `seed-event-${index + 1}`,
      team_id: teamId,
      occurred_at: occurredAt,
      recorded_at: now,
      brief,
      source_timeline_id: `seed-${Math.min(index + 1, 3)}`,
      review_count: team.review_count,
      metrics_snapshot: team.metrics_snapshot,
      tags: topTags(team.tag_counts).slice(0, 6),
      source_title: sanitizeSourceTitle(event.source_title),
      source_url: sanitizeSourceUrl(event.source_url),
    };
    atomic = atomic.set(
      ["team_major_event", teamId, publicTimeSortKey(majorEvent.occurred_at), majorEvent.id],
      majorEvent,
    );
  }

  const commit = await atomic.commit();
  if (!commit.ok) throw new Error("Failed to seed team");
  return teamId;
}
