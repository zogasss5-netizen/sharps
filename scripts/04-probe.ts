import "dotenv/config";

// Confirm live data is reachable: list today's fixtures, then pull odds for the first one.
// Requires GUEST_JWT + API_TOKEN in .env (run `npm run subscribe` first).

const BASE = process.env.TXLINE_BASE ?? "https://txline-dev.txodds.com";

function headers() {
  const jwt = process.env.GUEST_JWT, api = process.env.API_TOKEN;
  if (!jwt || !api) throw new Error("Missing GUEST_JWT / API_TOKEN in .env — run `npm run subscribe`.");
  return { Authorization: `Bearer ${jwt}`, "X-Api-Token": api };
}

async function get(path: string) {
  const r = await fetch(`${BASE}${path}`, { headers: headers() });
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  console.log("base:", BASE);
  const fixtures = await get("/api/fixtures/snapshot");
  const arr = Array.isArray(fixtures) ? fixtures : [];
  console.log(`fixtures today: ${arr.length}`);
  for (const f of arr.slice(0, 8)) {
    console.log(" -", JSON.stringify({
      id: f.fixtureId ?? f.id, comp: f.competitionId, home: f.home ?? f.homeTeam, away: f.away ?? f.awayTeam,
      start: f.startTime ?? f.kickoff,
    }));
  }
  const first = arr[0];
  const fid = first?.fixtureId ?? first?.id;
  if (fid) {
    console.log(`\nodds snapshot for fixture ${fid}:`);
    const odds = await get(`/api/odds/snapshot/${fid}`);
    console.log(JSON.stringify(odds, null, 2).slice(0, 1500));
  }
  console.log("\nLIVE DATA REACHABLE ✅ — S0 done.");
}

main().catch((e) => { console.error("probe failed:", e.message ?? e); process.exit(1); });
