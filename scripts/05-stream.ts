import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { sseStream } from "../src/ingest/sse.js";
import { Tape } from "../src/ingest/tape.js";
import { dataBase, dataHeaders } from "../src/ingest/auth.js";

// Connect to odds + scores SSE streams, log the first events (to discover the payload
// schema), save samples to data/samples/, and record everything to a tape.
// Usage: npm run stream            (default 20 events each, 120s cap)
//        npm run stream -- 50 300  (50 events, 300s)

const MAX = Number(process.argv[2] ?? 20);
const SECS = Number(process.argv[3] ?? 120);

async function capture(kind: "odds" | "scores", headers: Record<string, string>, signal: AbortSignal) {
  const url = `${dataBase()}/api/${kind}/stream`;
  const tape = new Tape(`${kind}-${new Date().toISOString().slice(0, 13)}`);
  const samples: unknown[] = [];
  let n = 0;
  console.log(`[${kind}] connecting ${url}`);
  try {
    for await (const ev of sseStream(url, {
      headers,
      signal,
      onOpen: () => console.log(`[${kind}] open`),
      onError: (e) => console.warn(`[${kind}] err:`, (e as Error).message),
    })) {
      tape.write(kind, ev.data, Date.now());
      if (n < MAX) {
        samples.push(ev.data);
        if (n < 3) console.log(`[${kind}] event ${n}:`, JSON.stringify(ev.data).slice(0, 600));
      }
      if (++n >= MAX) break;
    }
  } finally {
    tape.close();
    if (samples.length) {
      const dir = path.resolve("data/samples");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${kind}.sample.json`), JSON.stringify(samples, null, 2));
      console.log(`[${kind}] saved ${samples.length} samples -> data/samples/${kind}.sample.json`);
    }
  }
}

async function main() {
  const headers = dataHeaders();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SECS * 1000);
  await Promise.allSettled([
    capture("odds", headers, ac.signal),
    capture("scores", headers, ac.signal),
  ]);
  clearTimeout(timer);
  console.log("stream capture done.");
}

main().catch((e) => {
  console.error("stream failed:", e.message ?? e);
  process.exit(1);
});
