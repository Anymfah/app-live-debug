import * as path from "path";
import * as vscode from "vscode";

const NOTIFICATION_MSG = "Prompt copié — collez dans Composer (Ctrl+I)";

export interface TicketContext {
  url?: string;
  domPath?: string;
  consoleLogs?: string[];
  screenshotBase64?: string;
  [key: string]: unknown;
}

export interface Ticket {
  id: string;
  type?: string;
  description?: string;
  status?: string;
  context?: TicketContext;
  [key: string]: unknown;
}

export function formatTicketToText(ticket: Ticket): string {
  const parts: string[] = [];
  parts.push(`# Ticket ${ticket.id}`);
  if (ticket.type) parts.push(`Type: ${ticket.type}`);
  if (ticket.status) parts.push(`Status: ${ticket.status}`);
  if (ticket.description) parts.push(`\n${ticket.description}`);
  if (ticket.context && typeof ticket.context === "object") {
    parts.push("\n## Context\n");
    for (const [key, value] of Object.entries(ticket.context)) {
      if (key === "screenshotBase64" && typeof value === "string") {
        parts.push(`- **${key}**: [base64 image omitted]`);
      } else {
        parts.push(`- **${key}**: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      }
    }
  }
  return parts.join("\n").trim();
}

export async function copyToClipboardAndNotify(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage(NOTIFICATION_MSG);
  try {
    await vscode.commands.executeCommand("cursor.composer.open");
  } catch {
    // Cursor Composer command may not exist in this environment; ignore
  }
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : undefined;
}

async function readFileFromWorkspace(relativePath: string): Promise<Uint8Array | null> {
  const folder = getWorkspaceFolder();
  if (!folder) return null;
  const uri = vscode.Uri.joinPath(folder.uri, relativePath);
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return null;
  }
}

export async function readPendingPrompt(): Promise<string | null> {
  const folder = getWorkspaceFolder();
  if (!folder) return null;

  const pendingUri = vscode.Uri.joinPath(folder.uri, ".cursor", "pending-prompt.md");
  try {
    const data = await vscode.workspace.fs.readFile(pendingUri);
    return new TextDecoder().decode(data).trim() || null;
  } catch {
    // Fallback: first open or awaiting_test ticket from tickets.json
  }

  const tickets = await readTickets();
  if (!tickets) return null;
  const openStatuses = ["open", "awaiting_test"];
  const first = tickets.find((t) => openStatuses.includes((t.status || "").toLowerCase()));
  return first ? formatTicketToText(first) : null;
}

export async function readTickets(): Promise<Ticket[]> {
  const data = await readFileFromWorkspace(path.join(".cursor", "tickets.json"));
  if (!data) return [];
  try {
    const json = JSON.parse(new TextDecoder().decode(data));
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}
