import fs from "node:fs";
import path from "node:path";

// Append-only event recorder. One JSON object per line (jsonl) so we can replay
// live feeds deterministically for backtest/calibration. Tapes are gitignored.

export class Tape {
  private stream: fs.WriteStream;
  constructor(name: string, dir = "data/tape") {
    fs.mkdirSync(path.resolve(dir), { recursive: true });
    const file = path.resolve(dir, `${name}.jsonl`);
    this.stream = fs.createWriteStream(file, { flags: "a" });
  }
  /** Record one event with a wall-clock receive timestamp (ms). */
  write(kind: string, data: unknown, tsMs: number) {
    this.stream.write(JSON.stringify({ t: tsMs, kind, data }) + "\n");
  }
  close() {
    this.stream.end();
  }
}

/** Read a tape back as an array of records. */
export function readTape(file: string): Array<{ t: number; kind: string; data: unknown }> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readFileSync(abs, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
