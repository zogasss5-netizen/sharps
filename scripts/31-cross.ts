import "dotenv/config";
import { dataBase, dataHeaders } from "../src/ingest/auth.js";
import { normalizeFixture, WORLD_CUP_COMPETITION_ID } from "../src/model/normalize.js";
import { parseMarkets, jointFit, dislocations } from "../src/model/crossmarket.js";

// Show live cross-market triangulation: fit one (lambdaHome,lambdaAway) jointly to 1X2 + AH + OU,
// then the largest per-market residual = the offside market = the trade.
async function get(p: string) { const r = await fetch(`${dataBase()}${p}`, { headers: dataHeaders() }); return r.ok ? r.json() : []; }

async function main() {
  const fx = ((await get("/api/fixtures/snapshot")) as any[]).filter((f) => f.CompetitionId === WORLD_CUP_COMPETITION_ID).map(normalizeFixture);
  let shown = 0;
  for (const f of fx) {
    const odds = (await get(`/api/odds/snapshot/${f.fixtureId}`)) as any[];
    const m = parseMarkets(odds, f.p1IsHome);
    if (!m || !(m.x2 && (m.ah || m.ou))) continue;
    const fit = jointFit(m);
    const dis = dislocations(m, fit.lambdaHome, fit.lambdaAway);
    const top = dis[0]!;
    const present = [m.x2 && "1X2", m.ah && "AH", m.ou && "OU"].filter(Boolean).join("+");
    console.log(`\n${f.home} v ${f.away}  [${m.period}] markets=${present}  joint λ=${fit.lambdaHome.toFixed(2)}/${fit.lambdaAway.toFixed(2)} (err ${fit.err.toExponential(1)})`);
    if (m.ah) console.log(`   AH line ${m.ah.line}: market ${(m.ah.p1 * 100).toFixed(1)}% vs fair ${(dis.find(d => d.market === "AH")!.fairPrice * 100).toFixed(1)}%`);
    if (m.ou) console.log(`   OU line ${m.ou.line}: market ${(m.ou.over * 100).toFixed(1)}% vs fair ${(dis.find(d => d.market === "OU")!.fairPrice * 100).toFixed(1)}%`);
    console.log(`   >> most offside: ${top.market} ${top.detail}  residual ${top.residualBp > 0 ? "+" : ""}${top.residualBp}bp`);
    shown++;
  }
  console.log(`\n${shown} fixtures triangulated across markets.`);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
