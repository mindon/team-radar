import {
  collectPublicEventCandidates,
  listPublicEventCandidates,
  runPublicEventAdminAgent,
} from "./agents/public_event_collector.ts";
import { cleanAndStructureText } from "./llm.ts";
import {
  getPublicTeam,
  getTeamMajorEvents,
  getTeamTimeline,
  grantAccess,
  listPublicTeams,
  persistBufferedReview,
  processDueReviews,
  recordPublicMajorEvent,
} from "./store.ts";
import { IngestPayload } from "./types.ts";
import { jsonResponse, normalizeFreeText } from "./utils.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const TEAMRADAR_EDITION = Deno.env.get("TEAMRADAR_EDITION") === "public" ? "public" : "internal";
const AGENT_TOKEN = Deno.env.get("AGENT_TOKEN") ?? "";
const INTERNAL_ACCESS_MODE = Deno.env.get("INTERNAL_ACCESS_MODE") === "token" ? "token" : "open";
const INTERNAL_ACCESS_TOKEN = Deno.env.get("INTERNAL_ACCESS_TOKEN") ?? "";
const ORG_LABEL = TEAMRADAR_EDITION === "internal" ? "事业群" : "公司名称";
const ORG_FIELD = TEAMRADAR_EDITION === "internal" ? "group_name" : "group_name";
const ORG_PLACEHOLDER = TEAMRADAR_EDITION === "internal" ? "例如 CSIG" : "例如 Tencent";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function notFound(): Response {
  return jsonResponse({ error: "Not found" }, 404);
}

async function readJson<T>(req: Request): Promise<T> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  return await req.json() as T;
}

function hasBearer(req: Request, token: string): boolean {
  return Boolean(token) && req.headers.get("authorization") === `Bearer ${token}`;
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function ensureAgent(req: Request): Response | null {
  if (!AGENT_TOKEN) return null;
  if (!hasBearer(req, AGENT_TOKEN)) return jsonResponse({ error: "Unauthorized agent" }, 401);
  return null;
}

function hasInternalAccess(req: Request, url: URL): boolean {
  if (INTERNAL_ACCESS_MODE !== "token") return true;
  if (!INTERNAL_ACCESS_TOKEN) return false;
  return hasBearer(req, INTERNAL_ACCESS_TOKEN) || hasBearer(req, AGENT_TOKEN) ||
    req.headers.get("x-internal-access-token") === INTERNAL_ACCESS_TOKEN ||
    url.searchParams.get("access_token") === INTERNAL_ACCESS_TOKEN ||
    decodeURIComponent(cookieValue(req, "teamradar_internal") ?? "") === INTERNAL_ACCESS_TOKEN;
}

function ensureInternalAccess(req: Request, url: URL): Response | null {
  if (TEAMRADAR_EDITION !== "internal") return null;
  if (hasInternalAccess(req, url)) return null;
  return jsonResponse({ error: "Unauthorized internal access" }, 401);
}

async function handleIngest(req: Request): Promise<Response> {
  const payload = await readJson<IngestPayload>(req);
  const rawText = normalizeFreeText(payload.raw_content);
  const structured = await cleanAndStructureText(rawText);
  const queued = await persistBufferedReview(payload, structured);

  return jsonResponse({
    success: true,
    message: "Review cleaned by configured LLM and queued in Deno KV shadow buffer.",
    queued,
    structured_preview: structured,
  }, 202);
}

async function handleTeams(url: URL): Promise<Response> {
  const groupName = url.searchParams.get("group_name") ?? undefined;
  const teams = await listPublicTeams({
    query: url.searchParams.get("q") ?? undefined,
    group_name: groupName,
    tag: url.searchParams.get("tag") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 12),
  });
  return jsonResponse({ teams });
}

async function handleStatic(url: URL): Promise<Response> {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("..")) return notFound();

  const fileUrl = new URL(`../static${pathname}`, import.meta.url);
  try {
    const content = await Deno.readFile(fileUrl);
    const ext = pathname.match(/\.[^.]+$/)?.[0] ?? ".html";
    const response = new Response(content, {
      headers: {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
    if (
      TEAMRADAR_EDITION === "internal" && INTERNAL_ACCESS_MODE === "token" &&
      INTERNAL_ACCESS_TOKEN && url.searchParams.get("access_token") === INTERNAL_ACCESS_TOKEN
    ) {
      response.headers.set(
        "Set-Cookie",
        `teamradar_internal=${
          encodeURIComponent(INTERNAL_ACCESS_TOKEN)
        }; Path=/; HttpOnly; SameSite=Lax`,
      );
    }
    return response;
  } catch {
    return notFound();
  }
}

async function router(req: Request): Promise<Response> {
  const url = new URL(req.url);

  try {
    if (url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        runtime: "deno",
        kv: true,
        edition: TEAMRADAR_EDITION,
        org_label: ORG_LABEL,
        org_field: ORG_FIELD,
        org_placeholder: ORG_PLACEHOLDER,
      });
    }

    const deniedInternal = ensureInternalAccess(req, url);
    if (deniedInternal) return deniedInternal;

    if (
      (url.pathname === "/api/v1/clean-ingest" || url.pathname === "/api/v1/reviews") &&
      req.method === "POST"
    ) {
      return await handleIngest(req);
    }

    if (url.pathname === "/api/v1/teams" && req.method === "GET") {
      return await handleTeams(url);
    }

    if (url.pathname === "/api/v1/collector/run" && req.method === "POST") {
      const denied = ensureAgent(req);
      if (denied) return denied;
      const runAdminAgent = url.searchParams.get("admin_agent") === "1" ||
        Deno.env.get("PUBLIC_EVENT_ADMIN_AGENT") === "1";
      return jsonResponse({ stats: await collectPublicEventCandidates({ runAdminAgent }) });
    }

    if (url.pathname === "/api/v1/collector/admin-agent" && req.method === "POST") {
      const denied = ensureAgent(req);
      if (denied) return denied;
      const threshold = Number(url.searchParams.get("threshold") ?? undefined);
      const staleDays = Number(url.searchParams.get("stale_days") ?? undefined);
      return jsonResponse({
        stats: await runPublicEventAdminAgent({
          threshold: Number.isFinite(threshold) ? threshold : undefined,
          staleDays: Number.isFinite(staleDays) ? staleDays : undefined,
        }),
      });
    }

    if (url.pathname === "/api/v1/collector/candidates" && req.method === "GET") {
      const denied = ensureAgent(req);
      if (denied) return denied;
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const status = url.searchParams.get("status") ?? "candidate";
      return jsonResponse({
        candidates: await listPublicEventCandidates(
          limit,
          status as Parameters<typeof listPublicEventCandidates>[1],
        ),
      });
    }

    const timelineMatch = url.pathname.match(/^\/api\/v1\/teams\/([0-9a-f-]+)\/timeline$/i);
    if (timelineMatch && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 24);
      return jsonResponse({ timeline: await getTeamTimeline(timelineMatch[1], limit) });
    }

    const eventMatch = url.pathname.match(/^\/api\/v1\/teams\/([0-9a-f-]+)\/events$/i);
    if (eventMatch && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 24);
      return jsonResponse({ events: await getTeamMajorEvents(eventMatch[1], limit) });
    }
    if (eventMatch && req.method === "POST") {
      const denied = ensureAgent(req);
      if (denied) return denied;
      const payload = await readJson<Record<string, unknown>>(req);
      return jsonResponse({ event: await recordPublicMajorEvent(eventMatch[1], payload) }, 201);
    }

    const teamMatch = url.pathname.match(/^\/api\/v1\/teams\/([0-9a-f-]+)$/i);
    if (teamMatch && req.method === "GET") {
      const team = await getPublicTeam(teamMatch[1]);
      return team ? jsonResponse({ team }) : notFound();
    }

    if (url.pathname === "/api/v1/process-due" && req.method === "POST") {
      const denied = ensureAgent(req);
      if (denied) return denied;
      return jsonResponse(await processDueReviews());
    }

    if (url.pathname === "/api/v1/access-grant" && req.method === "POST") {
      const payload = await readJson<{ email?: unknown }>(req);
      return jsonResponse(await grantAccess(payload.email));
    }

    if (url.pathname.startsWith("/api/")) return notFound();
    if (req.method !== "GET" && req.method !== "HEAD") return notFound();
    return await handleStatic(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("DEEPSEEK_API_KEY") ? 503 : 400;
    return jsonResponse({ error: message }, status);
  }
}

if (typeof Deno.cron === "function") {
  Deno.cron("publish due TeamRadar reviews", "*/30 * * * *", async () => {
    await processDueReviews();
  });

  if (Deno.env.get("PUBLIC_EVENT_COLLECTOR_CRON") === "1") {
    Deno.cron("collect public TeamRadar events", "0 */6 * * *", async () => {
      await collectPublicEventCandidates({
        runAdminAgent: Deno.env.get("PUBLIC_EVENT_ADMIN_AGENT") === "1",
      });
    });
  }
}

Deno.serve({ port: PORT }, router);
console.log(`TeamRadar (${TEAMRADAR_EDITION}) listening on http://localhost:${PORT}`);
