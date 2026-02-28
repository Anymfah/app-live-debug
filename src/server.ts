import * as http from "http";

const DEFAULT_PORT = 8765;

let server: http.Server | null = null;

export interface PromptPayload {
  text?: string;
  description?: string;
  context?: Record<string, unknown>;
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startPromptServer(
  port: number = DEFAULT_PORT,
  onPrompt: (payload: PromptPayload) => void
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
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== "POST" || req.url !== "/prompt") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. Use POST /prompt" }));
        return;
      }

      try {
        const body = await parseBody(req);
        const parsed = JSON.parse(body || "{}");
        const payload: PromptPayload = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : parsed;
        const hasContent = !!(payload?.text || payload?.description || (payload?.context && Object.keys(payload.context).length > 0));
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
