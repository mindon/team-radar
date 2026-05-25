import { kv, recordPublicMajorEvent } from "../store.ts";
import {
  KnownTeamRecord,
  PublicEventCandidate,
  PublicEventEvidence,
  PublicEventSource,
  PublicEventSourceTrust,
  PublicEventType,
} from "../types.ts";
import { sha256Hex } from "../utils.ts";

const DEFAULT_SOURCE_FILE = new URL("../../data/public_sources.json", import.meta.url);
const DEFAULT_AGENT_CONFIRM_THRESHOLD = 0.88;
const DEFAULT_AGENT_STALE_DAYS = 14;
const KEYWORDS = [
  "reorg",
  "restructure",
  "roadmap",
  "strategy",
  "launch",
  "release",
  "deprecate",
  "sunset",
  "migration",
  "platform",
  "infrastructure",
  "ai",
  "cloud",
  "hiring",
  "layoff",
  "组织",
  "调整",
  "架构",
  "路线图",
  "发布",
  "升级",
  "下线",
  "迁移",
  "招聘",
  "裁员",
  "战略",
  "平台",
  "基础设施",
];

const EVENT_TYPE_KEYWORDS: Array<{ type: PublicEventType; keywords: string[]; score: number }> = [
  { type: "launch", keywords: ["launch", "推出", "上线", "发布", "introduce"], score: 0.9 },
  {
    type: "release",
    keywords: ["release", "version", "更新", "升级", "ga", "preview"],
    score: 0.82,
  },
  {
    type: "deprecation",
    keywords: ["deprecate", "deprecated", "sunset", "retire", "下线", "弃用", "停止维护"],
    score: 0.92,
  },
  { type: "migration", keywords: ["migration", "migrate", "迁移", "upgrade path"], score: 0.86 },
  { type: "roadmap", keywords: ["roadmap", "计划", "路线图", "future"], score: 0.8 },
  { type: "strategy", keywords: ["strategy", "strategic", "战略", "方向"], score: 0.78 },
  {
    type: "reorg",
    keywords: ["reorg", "restructure", "organization", "组织调整", "架构调整"],
    score: 0.84,
  },
  { type: "hiring", keywords: ["hiring", "招聘", "join us", "open roles"], score: 0.72 },
  { type: "layoff", keywords: ["layoff", "裁员", "workforce reduction"], score: 0.9 },
  {
    type: "infrastructure",
    keywords: ["infrastructure", "platform", "基础设施", "region", "datacenter"],
    score: 0.74,
  },
];

interface FeedItem {
  title: string;
  url: string;
  summary: string;
  published_at?: string;
}

interface CollectOptions {
  sourceFile?: string;
  limitPerSource?: number;
  runAdminAgent?: boolean;
  adminAgentThreshold?: number;
}

interface CollectStats {
  sources: number;
  fetched: number;
  candidates: number;
  skipped_seen: number;
  agent_confirmed: number;
  needs_evidence: number;
  agent_dismissed: number;
  errors: Array<{ source_id: string; message: string }>;
}

interface AdminAgentOptions {
  limit?: number;
  threshold?: number;
  staleDays?: number;
}

interface AdminAgentStats {
  reviewed: number;
  confirmed: number;
  needs_evidence: number;
  dismissed: number;
  skipped: number;
  errors: Array<{ candidate_id: string; message: string }>;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tagValue(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripHtml(match[1].replace(/<!\[CDATA\[|\]\]>/g, "")) : "";
}

function linkValue(block: string): string {
  const href = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1];
  if (href) return href.trim();
  return tagValue(block, "link").trim();
}

function normalizeUrl(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return base;
  }
}

function parseRss(text: string, baseUrl: string): FeedItem[] {
  const blocks = [...text.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
  return blocks.map((block) => ({
    title: tagValue(block, "title"),
    url: normalizeUrl(linkValue(block), baseUrl),
    summary: tagValue(block, "description") || tagValue(block, "summary") ||
      tagValue(block, "content"),
    published_at: tagValue(block, "pubDate") || tagValue(block, "updated") ||
      tagValue(block, "published"),
  })).filter((item) => item.title && item.url);
}

function parseHtml(text: string, baseUrl: string): FeedItem[] {
  const title = stripHtml(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = stripHtml(
    text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "",
  );
  const anchors = [...text.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      title: stripHtml(match[2]),
      url: normalizeUrl(match[1], baseUrl),
      summary: title || description,
    }))
    .filter((item) => item.title.length >= 8)
    .slice(0, 30);

  return [
    { title: title || baseUrl, url: baseUrl, summary: description },
    ...anchors,
  ];
}

function sourceTrust(source: PublicEventSource): PublicEventSourceTrust {
  return source.trust_level ?? "primary_public";
}

function sourceTrustScore(source: PublicEventSource): number {
  switch (sourceTrust(source)) {
    case "official":
      return 1;
    case "primary_public":
      return 0.86;
    case "reputable_media":
      return 0.72;
    case "community":
      return 0.48;
  }
}

function isAllowedDomain(url: string, source: PublicEventSource): boolean {
  if (!source.domain_allowlist?.length) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return source.domain_allowlist.some((domain) => {
      const normalized = domain.toLowerCase();
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

function isRelevant(item: FeedItem, source: PublicEventSource): boolean {
  if (!isAllowedDomain(item.url, source)) return false;
  const haystack = `${item.title} ${item.summary}`.toLowerCase();
  return [...KEYWORDS, ...source.group_hints, ...source.team_hints]
    .some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function occurredAt(item: FeedItem): string {
  const parsed = item.published_at ? new Date(item.published_at) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return date.toISOString().slice(0, 10);
}

function bestMatch(text: string, values: string[]): string {
  const normalized = text.toLowerCase();
  return values.find((value) => normalized.includes(value.toLowerCase())) ?? values[0] ?? "unknown";
}

function buildBrief(item: FeedItem): string {
  const summary = item.summary ? `：${item.summary}` : "";
  return stripHtml(`${item.title}${summary}`).slice(0, 120);
}

async function loadKnownTeams(): Promise<KnownTeamRecord[]> {
  const teams: KnownTeamRecord[] = [];
  for await (const entry of kv.list<KnownTeamRecord>({ prefix: ["known_team"] })) {
    teams.push(entry.value);
  }
  return teams;
}

function scoreKnownTeam(text: string, team: KnownTeamRecord): number {
  const haystack = text.toLowerCase();
  let score = 0;
  if (haystack.includes(team.group_name.toLowerCase())) score += 4;
  if (haystack.includes(team.team_alias.toLowerCase())) score += 5;
  for (const hint of team.team_hints) {
    if (haystack.includes(hint.toLowerCase())) score += 2;
  }
  return score;
}

function matchKnownTeam(text: string, teams: KnownTeamRecord[]): KnownTeamRecord | undefined {
  let best: { team: KnownTeamRecord; score: number } | undefined;
  for (const team of teams) {
    const score = scoreKnownTeam(text, team);
    if (score > 0 && (!best || score > best.score)) best = { team, score };
  }
  return best?.score && best.score >= 4 ? best.team : undefined;
}

function configuredSourceFile(sourceFile?: string): string | URL {
  return sourceFile ?? Deno.env.get("TEAMRADAR_EVENT_SOURCE_FILE") ??
    Deno.env.get("PUBLIC_EVENT_SOURCE_FILE") ?? Deno.env.get("INTERNAL_EVENT_SOURCE_FILE") ??
    DEFAULT_SOURCE_FILE;
}

async function readSources(sourceFile?: string): Promise<PublicEventSource[]> {
  const text = await Deno.readTextFile(configuredSourceFile(sourceFile));
  return JSON.parse(text) as PublicEventSource[];
}

function classifyEventType(text: string): { type: PublicEventType; score: number } {
  const haystack = text.toLowerCase();
  for (const candidate of EVENT_TYPE_KEYWORDS) {
    if (candidate.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      return { type: candidate.type, score: candidate.score };
    }
  }
  return { type: "other", score: 0.35 };
}

function monthBucket(value: string): string {
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : new Date().toISOString().slice(0, 7);
}

function freshnessScore(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 0.5;
  const days = Math.max(0, (Date.now() - time) / 86400000);
  if (days <= 45) return 1;
  if (days <= 180) return 0.75;
  if (days <= 365) return 0.5;
  return 0.25;
}

function normalizeFingerprintPart(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(
    0,
    80,
  ) ||
    "unknown";
}

function titleSignature(value: string): string {
  const stopWords = new Set([
    "with",
    "from",
    "into",
    "using",
    "about",
    "release",
    "launch",
    "update",
    "introducing",
    "announcing",
  ]);
  const tokens = value.toLowerCase().match(/[\p{L}\p{N}.+-]{4,}/gu) ?? [];
  const distinct = [...new Set(tokens.filter((token) => !stopWords.has(token)))].slice(0, 4);
  return distinct.length ? distinct.join("-") : value.slice(0, 32);
}

async function eventFingerprint(
  item: FeedItem,
  source: PublicEventSource,
  eventType: PublicEventType,
  occurred: string,
  suggested?: KnownTeamRecord,
): Promise<string> {
  const text = `${item.title} ${item.summary}`;
  const groupName = suggested?.group_name ?? bestMatch(text, source.group_hints);
  const team = suggested?.slug ?? suggested?.team_alias ?? bestMatch(text, source.team_hints);
  return await sha256Hex(
    [groupName, team, eventType, monthBucket(occurred), titleSignature(item.title)].map(
      normalizeFingerprintPart,
    ).join(":"),
  );
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

function scoreCandidate(
  source: PublicEventSource,
  itemUrl: string,
  matchConfidence: number,
  eventTypeScore: number,
  occurred: string,
): number {
  const domainScore = isAllowedDomain(itemUrl, source) ? 1 : 0;
  return roundScore(
    sourceTrustScore(source) * 0.3 +
      matchConfidence * 0.3 +
      eventTypeScore * 0.25 +
      domainScore * 0.1 +
      freshnessScore(occurred) * 0.05,
  );
}

async function candidateFromItem(
  source: PublicEventSource,
  item: FeedItem,
  knownTeams: KnownTeamRecord[],
): Promise<PublicEventCandidate> {
  const id = await sha256Hex(`${source.id}:${item.url}:${item.title}`);
  const text = `${item.title} ${item.summary}`;
  const suggested = matchKnownTeam(text, knownTeams);
  const teamScore = suggested ? scoreKnownTeam(text, suggested) : 0;
  const matchConfidence = suggested ? Math.min(1, teamScore / 10) : 0.22;
  const classified = classifyEventType(text);
  const occurred = occurredAt(item);
  const fingerprint = await eventFingerprint(item, source, classified.type, occurred, suggested);
  const fetchedAt = new Date().toISOString();
  const evidence: PublicEventEvidence[] = [{
    source_id: source.id,
    source_name: source.name,
    title: item.title.slice(0, 120),
    url: item.url,
    fetched_at: fetchedAt,
  }];

  return {
    id,
    source_id: source.id,
    source_name: source.name,
    source_url: source.url,
    source_title: item.title.slice(0, 120),
    source_item_url: item.url,
    source_trust_level: sourceTrust(source),
    source_auto_confirm: source.auto_confirm !== false,
    occurred_at: occurred,
    brief: buildBrief(item),
    matched_group: suggested?.group_name ?? bestMatch(text, source.group_hints),
    matched_team_hint: suggested?.team_alias ?? bestMatch(text, source.team_hints),
    suggested_team_id: suggested?.team_id,
    suggested_team_slug: suggested?.slug,
    suggested_team_label: suggested
      ? `${suggested.group_name} / ${suggested.dept_path}`
      : undefined,
    match_confidence: roundScore(matchConfidence),
    event_type: classified.type,
    event_fingerprint: fingerprint,
    confidence: scoreCandidate(source, item.url, matchConfidence, classified.score, occurred),
    evidence,
    status: "candidate",
    created_at: fetchedAt,
  };
}

function adminAgentThreshold(value?: number): number {
  const envValue = Number(Deno.env.get("PUBLIC_EVENT_ADMIN_AGENT_THRESHOLD"));
  const threshold = value ??
    (Number.isFinite(envValue) ? envValue : DEFAULT_AGENT_CONFIRM_THRESHOLD);
  return Math.min(0.99, Math.max(0.5, threshold));
}

function adminAgentStaleDays(value?: number): number {
  const envValue = Number(Deno.env.get("PUBLIC_EVENT_AGENT_STALE_DAYS"));
  const days = value ?? (Number.isFinite(envValue) ? envValue : DEFAULT_AGENT_STALE_DAYS);
  return Math.min(90, Math.max(1, days));
}

function isStaleCandidate(candidate: PublicEventCandidate, staleDays: number): boolean {
  return Date.now() - Date.parse(candidate.created_at) > staleDays * 24 * 60 * 60 * 1000;
}

function canAgentConfirm(
  candidate: PublicEventCandidate,
  independentEvidenceCount: number,
  threshold: number,
): { ok: boolean; reason: string } {
  if (!candidate.source_auto_confirm) return { ok: false, reason: "source_auto_confirm_disabled" };
  if (!candidate.suggested_team_id) return { ok: false, reason: "missing_suggested_team" };
  if (candidate.event_type === "other") return { ok: false, reason: "weak_event_type" };

  const officialHighConfidence = candidate.confidence >= threshold;
  const multiSourceHighConfidence = independentEvidenceCount >= 2 &&
    candidate.confidence >= threshold - 0.08;
  if (officialHighConfidence) return { ok: true, reason: "agent_source_trust_and_high_confidence" };
  if (multiSourceHighConfidence) return { ok: true, reason: "agent_multi_source_high_confidence" };
  return { ok: false, reason: "below_agent_confirm_threshold" };
}

async function markCandidate(
  candidate: PublicEventCandidate,
  patch: Partial<PublicEventCandidate>,
): Promise<PublicEventCandidate> {
  const next: PublicEventCandidate = { ...candidate, ...patch };
  await kv.set(["collector_candidate_by_id", candidate.id], next);
  await kv.set(["collector_candidate", Date.parse(next.created_at), candidate.id], next);
  return next;
}

async function publishCandidateEvent(
  candidate: PublicEventCandidate,
  targetTeamId: string,
  confirmedBy: "agent" | "auto" | "manual",
  confirmReason: string,
): Promise<{ eventId?: string; duplicate: boolean }> {
  const fingerprint = candidate.event_fingerprint || candidate.id;
  const duplicateKey: Deno.KvKey = ["collector_confirmed_fingerprint", targetTeamId, fingerprint];
  const duplicate = await kv.get<{ event_id: string }>(duplicateKey);
  if (duplicate.value) return { eventId: duplicate.value.event_id, duplicate: true };

  const event = await recordPublicMajorEvent(targetTeamId, {
    occurred_at: candidate.occurred_at,
    brief: candidate.brief,
    source_title: candidate.source_title,
    source_url: candidate.source_item_url,
    event_type: candidate.event_type,
    event_fingerprint: fingerprint,
    confidence: candidate.confidence,
    confirmed_by: confirmedBy,
    confirm_reason: confirmReason,
    collector_candidate_id: candidate.id,
  });
  await kv.set(duplicateKey, {
    event_id: event.id,
    candidate_id: candidate.id,
    confirmed_at: event.recorded_at,
  });
  return { eventId: event.id, duplicate: false };
}

export async function collectPublicEventCandidates(
  options: CollectOptions = {},
): Promise<CollectStats> {
  const sources = await readSources(options.sourceFile);
  const knownTeams = await loadKnownTeams();
  const stats: CollectStats = {
    sources: sources.length,
    fetched: 0,
    candidates: 0,
    skipped_seen: 0,
    agent_confirmed: 0,
    needs_evidence: 0,
    agent_dismissed: 0,
    errors: [],
  };
  const limitPerSource = Math.min(Math.max(options.limitPerSource ?? 8, 1), 50);

  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        headers: { "User-Agent": "TeamRadarPublicEventCollector/0.2" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const items =
        (source.kind === "rss" ? parseRss(text, source.url) : parseHtml(text, source.url))
          .filter((item) => isRelevant(item, source))
          .slice(0, limitPerSource);
      stats.fetched += items.length;

      for (const item of items) {
        const candidate = await candidateFromItem(source, item, knownTeams);
        const seenKey = ["collector_seen", candidate.id];
        const seen = await kv.get(seenKey);
        if (seen.value) {
          stats.skipped_seen++;
          continue;
        }

        const createdAt = Date.parse(candidate.created_at);
        await kv.atomic()
          .set(seenKey, { source_id: source.id, seen_at: candidate.created_at })
          .set(["collector_candidate", createdAt, candidate.id], candidate)
          .set(["collector_candidate_by_id", candidate.id], candidate)
          .commit();
        stats.candidates++;
      }
    } catch (error) {
      stats.errors.push({
        source_id: source.id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  if (options.runAdminAgent) {
    const agentStats = await runPublicEventAdminAgent({
      threshold: options.adminAgentThreshold,
    });
    stats.agent_confirmed = agentStats.confirmed;
    stats.needs_evidence = agentStats.needs_evidence;
    stats.agent_dismissed = agentStats.dismissed;
    stats.errors.push(...agentStats.errors.map((error) => ({
      source_id: `candidate:${error.candidate_id}`,
      message: error.message,
    })));
  }

  return stats;
}

export async function listPublicEventCandidates(
  limit = 50,
  status: PublicEventCandidate["status"] | "all" = "candidate",
): Promise<PublicEventCandidate[]> {
  const candidates: PublicEventCandidate[] = [];
  for await (const entry of kv.list<PublicEventCandidate>({ prefix: ["collector_candidate"] })) {
    if (status === "all" || entry.value.status === status) candidates.push(entry.value);
  }

  return candidates
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, Math.min(Math.max(limit, 1), 200));
}

async function confirmPublicEventCandidate(
  candidateId: string,
  teamId?: string,
  confirmedBy: "agent" | "auto" | "manual" = "agent",
  confirmReason = "agent_confirmed",
): Promise<PublicEventCandidate> {
  const entry = await kv.get<PublicEventCandidate>(["collector_candidate_by_id", candidateId]);
  if (!entry.value) throw new Error("Candidate not found");
  const candidate = entry.value;
  const targetTeamId = teamId ?? candidate.suggested_team_id;
  if (!targetTeamId) throw new Error("Missing team_id");

  const published = await publishCandidateEvent(
    candidate,
    targetTeamId,
    confirmedBy,
    confirmReason,
  );
  return await markCandidate(candidate, {
    status: confirmedBy === "agent"
      ? "agent_confirmed"
      : confirmedBy === "auto"
      ? "auto_confirmed"
      : "confirmed",
    confirmed_at: new Date().toISOString(),
    confirmed_by: confirmedBy,
    confirmed_team_id: targetTeamId,
    confirm_reason: published.duplicate
      ? `${confirmReason}:duplicate_fingerprint_skipped`
      : confirmReason,
    published_event_id: published.eventId,
  });
}

async function listAdminAgentReviewCandidates(limit: number): Promise<PublicEventCandidate[]> {
  const candidates: PublicEventCandidate[] = [];
  for await (const entry of kv.list<PublicEventCandidate>({ prefix: ["collector_candidate"] })) {
    if (["candidate", "needs_review", "needs_evidence"].includes(entry.value.status)) {
      candidates.push(entry.value);
    }
  }

  return candidates
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, Math.min(Math.max(limit, 1), 500));
}

function shouldDismissByAgent(
  candidate: PublicEventCandidate,
  reason: string,
  staleDays: number,
): boolean {
  if (isStaleCandidate(candidate, staleDays)) return true;
  return [
    "missing_suggested_team",
    "weak_event_type",
    "source_auto_confirm_disabled",
  ].includes(reason);
}

export async function runPublicEventAdminAgent(
  options: AdminAgentOptions = {},
): Promise<AdminAgentStats> {
  const threshold = adminAgentThreshold(options.threshold);
  const staleDays = adminAgentStaleDays(options.staleDays);
  const candidates = await listAdminAgentReviewCandidates(options.limit ?? 100);
  const byFingerprint = new Map<string, PublicEventCandidate[]>();
  for (const candidate of candidates) {
    const bucket = byFingerprint.get(candidate.event_fingerprint) ?? [];
    bucket.push(candidate);
    byFingerprint.set(candidate.event_fingerprint, bucket);
  }

  const stats: AdminAgentStats = {
    reviewed: candidates.length,
    confirmed: 0,
    needs_evidence: 0,
    dismissed: 0,
    skipped: 0,
    errors: [],
  };

  for (const candidate of candidates) {
    try {
      const peers = byFingerprint.get(candidate.event_fingerprint) ?? [candidate];
      const independentEvidenceCount = new Set(peers.map((peer) => peer.source_id)).size;
      const decision = canAgentConfirm(candidate, independentEvidenceCount, threshold);
      if (decision.ok) {
        await confirmPublicEventCandidate(
          candidate.id,
          candidate.suggested_team_id,
          "agent",
          decision.reason,
        );
        stats.confirmed++;
        continue;
      }

      if (shouldDismissByAgent(candidate, decision.reason, staleDays)) {
        const reason = isStaleCandidate(candidate, staleDays)
          ? `agent_stale_after_${staleDays}_days`
          : decision.reason;
        await markCandidate(candidate, { status: "agent_dismissed", confirm_reason: reason });
        stats.dismissed++;
        continue;
      }

      await markCandidate(candidate, { status: "needs_evidence", confirm_reason: decision.reason });
      stats.needs_evidence++;
    } catch (error) {
      stats.errors.push({
        candidate_id: candidate.id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      stats.skipped++;
    }
  }

  return stats;
}

if (import.meta.main) {
  const stats = await collectPublicEventCandidates({
    runAdminAgent: Deno.env.get("PUBLIC_EVENT_ADMIN_AGENT") === "1",
  });
  console.log(JSON.stringify(stats, null, 2));
}
