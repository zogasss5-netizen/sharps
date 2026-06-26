import fs from "node:fs";
import path from "node:path";

/** Upsert KEY=VALUE pairs into the .env file (creating it if missing). */
export function writeEnv(updates: Record<string, string>, file = ".env") {
  const p = path.resolve(file);
  let lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    const line = `${k}=${v}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  fs.writeFileSync(p, lines.join("\n"));
}
