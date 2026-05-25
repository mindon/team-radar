import { kv, resolveTeamId } from "./store.ts";
import { KnownTeamRecord, KnownTeamSeed } from "./types.ts";
import { normalizeOrgPart } from "./utils.ts";

const KNOWN_TEAMS_FILE = new URL("../docs/known_teams.json", import.meta.url);

const text = await Deno.readTextFile(KNOWN_TEAMS_FILE);
const teams = JSON.parse(text) as KnownTeamSeed[];

for (const team of teams) {
  const groupName = normalizeOrgPart(team.group_name, "group_name");
  const deptPath = normalizeOrgPart(team.dept_path, "dept_path");
  const teamId = await resolveTeamId(groupName, deptPath);
  const now = new Date().toISOString();
  const record: KnownTeamRecord = {
    ...team,
    group_name: groupName,
    dept_path: deptPath,
    team_id: teamId,
    contribution_path: `/contribute/${team.slug}`,
    created_at: now,
    updated_at: now,
  };

  await kv.atomic()
    .set(["known_team", team.slug], record)
    .set(["known_team_by_group", groupName, team.slug], record)
    .commit();

  console.log(`${team.slug} -> ${teamId} ${record.contribution_path}`);
}

console.log(`Seeded ${teams.length} known teams.`);
