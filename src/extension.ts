import * as vscode from "vscode";

import { getSession, startPromptServer, stopPromptServer } from "./server";
import { buildPromptFromPayload, buildPromptFromTicket, getOutputChannel, handleIncomingPrompt, readPendingPromptSource, readTickets } from "./utils";

export function activate(context: vscode.ExtensionContext): void {
  const port = vscode.workspace.getConfiguration("appLiveDebug").get<number>("serverPort") ?? 8765;
  startPromptServer(port, async (payload, sessionId) => {
    const text = await buildPromptFromPayload(payload);
    if (text) {
      await handleIncomingPrompt(text, sessionId, payload.contextId);
    } else if (sessionId) {
      const session = getSession(sessionId);
      if (session) {
        session.push("error", "Empty prompt after building from payload.");
        session.push("end", "");
        session.done = true;
      }
    }
  }).then((actualPort) => {
    const channel = getOutputChannel();
    channel.appendLine(`Server listening on http://127.0.0.1:${actualPort} (POST /prompt, GET /prompt/stream?sessionId=...)`);
    channel.show(true);
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[App Live Debug] Server failed to start:", msg);
    vscode.window.showWarningMessage(`App Live Debug: ${msg}`);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("appLiveDebug.copyPendingPrompt", async () => {
      const source = await readPendingPromptSource();
      if (!source) {
        vscode.window.showWarningMessage("App Live Debug: No pending prompt or open ticket found.");
        return;
      }
      const text = source.type === "file" ? source.text : await buildPromptFromTicket(source.ticket);
      if (text) await handleIncomingPrompt(text);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("appLiveDebug.pickTicketToComposer", async () => {
      const tickets = await readTickets();
      if (!tickets || tickets.length === 0) {
        vscode.window.showWarningMessage("App Live Debug: No tickets in .cursor/tickets.json.");
        return;
      }
      const items = tickets.map((t) => ({
        label: `#${t.id} ${(t.description || "").slice(0, 50)}${(t.description || "").length > 50 ? "…" : ""}`,
        description: (t as { status?: string }).status ?? "",
        ticket: t,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a ticket to copy to clipboard for Composer",
        matchOnDescription: true,
      });
      if (picked) {
        const text = await buildPromptFromTicket(picked.ticket);
        if (text) await handleIncomingPrompt(text);
      }
    })
  );
}

export function deactivate(): void {
  stopPromptServer();
}
