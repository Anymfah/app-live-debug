import * as http from "http";
import * as url from "url";
import { randomUUID } from "crypto";

const DEFAULT_PORT = 8765;
const STREAMING_HEADER = "x-request-streaming";

let server: http.Server | null = null;

export interface PromptPayload {
  text?: string;
  description?: string;
  context?: Record<string, unknown>;
  /** When set, pass --resume <contextId> to the agent so this message continues that chat (enables multiple chat windows). */
  contextId?: string;
}

export interface SessionChunk {
  event: string;
  data: string;
}

type SessionListener = (chunk: SessionChunk) => void;

export interface Session {
  id: string;
  chunks: SessionChunk[];
  done: boolean;
  push(event: string, data: string): void;
  addListener(cb: SessionListener): void;
  removeListener(cb: SessionListener): void;
}

const sessions = new Map<string, Session>();

function createSession(): Session {
  const id = randomUUID();
  const chunks: SessionChunk[] = [];
  const listeners = new Set<SessionListener>();

  const push = (event: string, data: string): void => {
    const chunk: SessionChunk = { event, data };
    chunks.push(chunk);
    listeners.forEach((cb) => {
      try {
        cb(chunk);
      } catch (_e) {
        // ignore listener errors
      }
    });
  };

  const session: Session = {
    id,
    chunks,
    done: false,
    push,
    addListener(cb: SessionListener) {
      listeners.add(cb);
    },
    removeListener(cb: SessionListener) {
      listeners.delete(cb);
    },
  };

  sessions.set(id, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/** Format a single SSE event (event type + data, newline-safe). */
function formatSSE(event: string, data: string): string {
  const dataLines = data.split(/\r?\n/).map((line) => `data: ${line}`);
  return `event: ${event}\n${dataLines.join("\n")}\n\n`;
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseUrl(req: http.IncomingMessage): { pathname: string; query: Record<string, string> } {
  const parsed = url.parse(req.url ?? "", true);
  const pathname = parsed.pathname ?? "";
  const query = (parsed.query as Record<string, string>) ?? {};
  return { pathname, query };
}

export function startPromptServer(
  port: number = DEFAULT_PORT,
  onPrompt: (payload: PromptPayload, sessionId?: string) => void | Promise<void>
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      server.close(() => {
        server = null;
        startPromptServer(port, onPrompt).then(resolve).catch(reject);
      });
      return;
    }

    server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Request-Streaming");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const { pathname, query } = parseUrl(req);

      // GET /prompt/stream?sessionId=xxx — SSE stream for agent output
      if (req.method === "GET" && pathname === "/prompt/stream") {
        const sessionId = query.sessionId;
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing sessionId. Use GET /prompt/stream?sessionId=..." }));
          return;
        }
        const session = sessions.get(sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found", sessionId }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders?.();

        const send = (chunk: SessionChunk) => {
          res.write(formatSSE(chunk.event, chunk.data));
          res.flushHeaders?.();
        };

        for (const chunk of session.chunks) {
          send(chunk);
        }
        if (session.done) {
          res.end();
          return;
        }

        session.addListener(send);
        req.on("close", () => {
          session.removeListener(send);
        });

        const checkDone = (chunk: SessionChunk): void => {
          if (chunk.event === "end") {
            session.removeListener(send);
            session.removeListener(checkDone);
            res.end();
          }
        };
        session.addListener(checkDone);
        return;
      }

      if (req.method !== "POST" || pathname !== "/prompt") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. Use POST /prompt or GET /prompt/stream?sessionId=..." }));
        return;
      }

      const wantsStreaming = (req.headers[STREAMING_HEADER] ?? req.headers["x-request-streaming"]) === "true" || 
        (req.headers["accept"] ?? "").toLowerCase().includes("text/event-stream");

      try {
        const body = await parseBody(req);
        const parsed = JSON.parse(body || "{}");
        const payload: PromptPayload = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : parsed;
        const hasContent = !!(payload?.text || payload?.description || (payload?.context && Object.keys(payload.context).length > 0));

        if (wantsStreaming && hasContent) {
          const session = createSession();
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessionId: session.id }));
          void Promise.resolve(onPrompt(payload, session.id)).catch((e) => {
            session.push("error", (e as Error).message ?? String(e));
            session.push("end", "");
            session.done = true;
          });
          return;
        }

        if (hasContent) {
          onPrompt(payload);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, received: hasContent }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });

    server.listen(port, "127.0.0.1", () => {
      resolve(port);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Change appLiveDebug.serverPort in settings or free the port.`));
      } else {
        reject(err);
      }
    });
  });
}

export function stopPromptServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}
