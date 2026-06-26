import "dotenv/config";

export function dataBase(): string {
  return process.env.TXLINE_BASE ?? "https://txline-dev.txodds.com";
}

/** Headers required by every TxLINE data endpoint: guest JWT + long-lived API token. */
export function dataHeaders(): Record<string, string> {
  const jwt = process.env.GUEST_JWT;
  const api = process.env.API_TOKEN;
  if (!jwt || !api) {
    throw new Error("Missing GUEST_JWT / API_TOKEN in .env — run `npm run subscribe` first.");
  }
  return { Authorization: `Bearer ${jwt}`, "X-Api-Token": api };
}

/** Mint a fresh guest JWT (they last 30 days). */
export async function freshGuestJwt(base = dataBase()): Promise<string> {
  const r = await fetch(`${base}/auth/guest/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`guest/start HTTP ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}
