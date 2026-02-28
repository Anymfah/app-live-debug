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

function formatPayloadToText(payload: PromptPayload): string {
  if (payload.text && typeof payload.text === "string") {
    return payload.text;
  }
  const parts: string[] = [];
  if (payload.description && typeof payload.description === "string") {
    parts.push(payload.description);
  }
  if (payload.context && typeof payload.context === "object") {
    parts.push("\n## Context\n");
    for (const [key, value] of Object.entries(payload.context)) {
      parts.push(`- **${key}**: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
  }
  return parts.join("\n").trim() || "";
}

export function startPromptServer(
  port: number = DEFAULT_PORT,
  onPrompt: (text: string) => void
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
        const payload = JSON.parse(body || "{}") as PromptPayload;
        const text = formatPayloadToText(payload);
        if (text) {
          onPrompt(text);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, copied: !!text }));
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
