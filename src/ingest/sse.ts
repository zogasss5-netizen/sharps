// Robust Server-Sent-Events client for the TxLINE odds/scores streams.
// Schema-agnostic: yields parsed JSON payloads. Handles chunk-split lines,
// "data: " / "Message: " prefixes, comments, and auto-reconnect with backoff.

export interface SseEvent {
  raw: string;
  data: unknown;
}

export interface SseOptions {
  headers: Record<string, string>;
  signal?: AbortSignal;
  /** ms between reconnect attempts (capped exponential). Default base 1000. */
  reconnectBaseMs?: number;
  onOpen?: () => void;
  onError?: (e: unknown) => void;
}

const PREFIXES = ["data: ", "data:", "Message: ", "message: "];

function stripPrefix(line: string): string | null {
  for (const p of PREFIXES) if (line.startsWith(p)) return line.slice(p.length);
  // bare JSON line (some servers emit raw)
  if (line.startsWith("{") || line.startsWith("[")) return line;
  return null;
}

/** Async generator of parsed SSE payloads from `url`. Reconnects until aborted. */
export async function* sseStream(url: string, opts: SseOptions): AsyncGenerator<SseEvent> {
  const base = opts.reconnectBaseMs ?? 1000;
  let attempt = 0;

  while (!opts.signal?.aborted) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache", ...opts.headers },
        signal: opts.signal,
      });
      if (!res.ok || !res.body) {
        const body = res.ok ? "(no body)" : await res.text().catch(() => "");
        throw new Error(`stream HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      opts.onOpen?.();
      attempt = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (!line || line.startsWith(":")) continue; // keepalive / comment
            const payload = stripPrefix(line);
            if (payload == null) continue;
            try {
              yield { raw: line, data: JSON.parse(payload) };
            } catch {
              /* partial/non-JSON frame; skip */
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (e) {
      if (opts.signal?.aborted) return;
      opts.onError?.(e);
    }
    // backoff before reconnect
    attempt++;
    const wait = Math.min(base * 2 ** Math.min(attempt, 5), 30_000);
    await new Promise((r) => setTimeout(r, wait));
  }
}
