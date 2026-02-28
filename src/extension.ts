import * as vscode from "vscode";

import { startPromptServer, stopPromptServer } from "./server";
import { copyToClipboardAndNotify, formatTicketToText, readPendingPrompt, readTickets } from "./utils";

export function activate(context: vscode.ExtensionContext): void {
  const port = vscode.workspace.getConfiguration("appLiveDebug").get<number>("serverPort") ?? 8765;
  startPromptServer(port, (text) => {
    void copyToClipboardAndNotify(text);
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[App Live Debug] Server failed to start:", msg);
    vscode.window.showWarningMessage(`App Live Debug: ${msg}`);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("appLiveDebug.copyPendingPrompt", async () => {
      const text = await readPendingPrompt();
      if (text) {
        copyToClipboardAndNotify(text);
      } else {
        vscode.window.showWarningMessage("App Live Debug: No pending prompt or open ticket found.");
      }
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
        const text = formatTicketToText(picked.ticket);
        copyToClipboardAndNotify(text);
      }
    })
  );
}

export function deactivate(): void {
  stopPromptServer();
}
