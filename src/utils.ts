import * as path from "path";
import * as vscode from "vscode";
import { getSession } from "./server";

const NOTIFICATION_MSG = "Prompt copié — Composer ouvert, collage automatique…";
const COMPOSER_OPEN_DELAY_MS = 800;
const OUTPUT_CHANNEL_NAME = "App Live Debug (Agent)";
const SCREENSHOT_RELATIVE_PATH = ".cursor/app-live-debug-screenshot.png";

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

/** Extract base64 from data URL or return as-is if already raw base64. */
function parseBase64Image(dataUrlOrBase64: string): Buffer | null {
  const s = typeof dataUrlOrBase64 === "string" ? dataUrlOrBase64.trim() : "";
  if (!s) return null;
  const base64 = s.startsWith("data:") ? s.replace(/^data:image\/[^;]+;base64,/, "") : s;
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

/**
 * Write screenshot (data URL or base64) to workspace .cursor folder so the CLI agent can read it.
 * Returns the relative path (e.g. ".cursor/app-live-debug-screenshot.png") or null on failure.
 */
export async function writeScreenshotToWorkspace(
  dataUrlOrBase64: string,
  folder: vscode.WorkspaceFolder
): Promise<string | null> {
  const buf = parseBase64Image(dataUrlOrBase64);
  if (!buf || buf.length === 0) return null;
  const dirUri = vscode.Uri.joinPath(folder.uri, ".cursor");
  const fileUri = vscode.Uri.joinPath(folder.uri, SCREENSHOT_RELATIVE_PATH);
  try {
    await vscode.workspace.fs.createDirectory(dirUri);
    await vscode.workspace.fs.writeFile(fileUri, buf);
    return SCREENSHOT_RELATIVE_PATH;
  } catch {
    return null;
  }
}

export interface PromptPayload {
  text?: string;
  description?: string;
  context?: Record<string, unknown>;
}

/**
 * Build prompt text from API payload. If context contains screenshotBase64, writes image to
 * .cursor/app-live-debug-screenshot.png and adds that path to the prompt so the agent can read it.
 */
export async function buildPromptFromPayload(payload: PromptPayload): Promise<string> {
  const folder = getWorkspaceFolder();
  if (payload.text && typeof payload.text === "string") {
    return payload.text;
  }
  const parts: string[] = [];
  if (payload.description && typeof payload.description === "string") {
    parts.push(payload.description);
  }
  if (payload.context && typeof payload.context === "object") {
    parts.push("\n## Context\n");
    const screenshotBase64 = payload.context.screenshotBase64;
    if (typeof screenshotBase64 === "string" && folder) {
      const screenshotPath = await writeScreenshotToWorkspace(screenshotBase64, folder);
      if (screenshotPath) {
        parts.push(`- **Screenshot**: ${screenshotPath} (see image for UI state)\n`);
      }
    }
    for (const [key, value] of Object.entries(payload.context)) {
      if (key === "screenshotBase64") continue;
      parts.push(`- **${key}**: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
  }
  return parts.join("\n").trim() || "";
}

/**
 * Build prompt text from a ticket, writing screenshot to workspace if present so the agent can read the image.
 */
export async function buildPromptFromTicket(ticket: Ticket): Promise<string> {
  const folder = getWorkspaceFolder();
  const parts: string[] = [];
  parts.push(`# Ticket ${ticket.id}`);
  if (ticket.type) parts.push(`Type: ${ticket.type}`);
  if (ticket.status) parts.push(`Status: ${ticket.status}`);
  if (ticket.description) parts.push(`\n${ticket.description}`);
  if (ticket.context && typeof ticket.context === "object") {
    parts.push("\n## Context\n");
    const screenshotBase64 = ticket.context.screenshotBase64;
    if (typeof screenshotBase64 === "string" && folder) {
      const screenshotPath = await writeScreenshotToWorkspace(screenshotBase64, folder);
      if (screenshotPath) {
        parts.push(`- **Screenshot**: ${screenshotPath} (see image for UI state)\n`);
      }
    }
    for (const [key, value] of Object.entries(ticket.context)) {
      if (key === "screenshotBase64") continue;
      parts.push(`- **${key}**: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
  }
  return parts.join("\n").trim();
}

export async function copyToClipboardAndNotify(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  try {
    await vscode.commands.executeCommand("cursor.composer.open");
    setTimeout(() => {
      void vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    }, COMPOSER_OPEN_DELAY_MS);
    vscode.window.showInformationMessage(NOTIFICATION_MSG);
  } catch {
    vscode.window.showInformationMessage("Prompt copié — collez dans Composer (Ctrl+I)");
  }
}

function getOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
}

/**
 * Handle incoming prompt: either run Cursor CLI agent headless or copy to clipboard + open Composer.
 * When sessionId is provided (streaming mode), agent stdout/stderr and end/error are pushed to the session for SSE.
 */
export async function handleIncomingPrompt(text: string, sessionId?: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("appLiveDebug");
  const useHeadless = config.get<boolean>("useHeadlessAgent") ?? true;
  const allowFileChanges = config.get<boolean>("agentAllowFileChanges") ?? true;
  const session = sessionId ? getSession(sessionId) : undefined;

  if (useHeadless) {
    const { runHeadlessAgent, getWorkspaceRoot } = await import("./agent");
    const cwd = getWorkspaceRoot();
    if (!cwd) {
      const msg = "App Live Debug: No workspace folder open. Open a project folder first.";
      if (session) {
        session.push("error", msg);
        session.push("end", "");
        session.done = true;
      } else {
        vscode.window.showWarningMessage(msg);
      }
      return;
    }
    const model = config.get<string>("agentModel") ?? "auto";
    if (!session) {
      vscode.window.showInformationMessage("App Live Debug: Agent headless en cours d'exécution…");
    }
    const result = await runHeadlessAgent({
      prompt: text,
      cwd,
      allowFileChanges,
      model: model || undefined,
      onOutput: session
        ? (data: string, stream: "stdout" | "stderr") => session.push(stream, data)
        : undefined,
    });
    if (session) {
      if (result.error) {
        session.push("error", result.error);
      }
      session.push("end", result.success ? "0" : "1");
      session.done = true;
    } else {
      if (result.success) {
        vscode.window.showInformationMessage("App Live Debug: Agent headless terminé. Voir Output > App Live Debug (Agent).");
      } else if (result.error) {
        vscode.window.showErrorMessage(`App Live Debug: ${result.error}`);
      }
      getOutputChannel().show(true);
    }
    return;
  }

  if (session) {
    session.push("error", "Streaming requires headless agent. Enable appLiveDebug.useHeadlessAgent.");
    session.push("end", "");
    session.done = true;
    return;
  }
  await copyToClipboardAndNotify(text);
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
  const source = await readPendingPromptSource();
  if (!source) return null;
  if (source.type === "file") return source.text;
  return formatTicketToText(source.ticket);
}

/**
 * Returns the pending prompt as either file content or the first open/awaiting_test ticket (for screenshot support).
 */
export async function readPendingPromptSource(): Promise<
  { type: "file"; text: string } | { type: "ticket"; ticket: Ticket } | null
> {
  const folder = getWorkspaceFolder();
  if (!folder) return null;

  const pendingUri = vscode.Uri.joinPath(folder.uri, ".cursor", "pending-prompt.md");
  try {
    const data = await vscode.workspace.fs.readFile(pendingUri);
    const text = new TextDecoder().decode(data).trim();
    if (text) return { type: "file", text };
  } catch {
    // Fallback: first open or awaiting_test ticket from tickets.json
  }

  const tickets = await readTickets();
  if (!tickets) return null;
  const openStatuses = ["open", "awaiting_test"];
  const first = tickets.find((t) => openStatuses.includes((t.status || "").toLowerCase()));
  return first ? { type: "ticket", ticket: first } : null;
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
