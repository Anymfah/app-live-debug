import * as child_process from "child_process";
import * as path from "path";
import * as vscode from "vscode";

const OUTPUT_CHANNEL_NAME = "App Live Debug (Agent)";
const AGENT_CMD = "agent";

export interface RunAgentOptions {
  prompt: string;
  cwd: string;
  allowFileChanges: boolean;
  /** Model to use (e.g. "auto", "gpt-5.2", "sonnet-4.5-thinking"). Empty string = do not pass --model. */
  model?: string;
  /** Optional callback for streaming stdout/stderr (e.g. for SSE). */
  onOutput?: (data: string, stream: "stdout" | "stderr") => void;
}

function getOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
}

/**
 * Run Cursor CLI agent in headless (non-interactive) mode.
 * See https://cursor.com/fr/docs/cli/headless
 * Requires: Cursor CLI installed (irm 'https://cursor.com/install?win32=true' | iex) and CURSOR_API_KEY set for scripts.
 */
export function runHeadlessAgent(options: RunAgentOptions): Promise<{ success: boolean; error?: string }> {
  const { prompt, cwd, allowFileChanges, model, onOutput } = options;
  const channel = getOutputChannel();
  channel.clear();
  channel.appendLine(`[App Live Debug] Running Cursor agent (headless) in ${cwd}`);
  if (model) channel.appendLine(`Model: ${model}`);
  channel.appendLine(`Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`);
  channel.appendLine("");

  return new Promise((resolve) => {
    const args: string[] = ["-p"];
    if (model && model.trim()) {
      args.push("--model", model.trim());
    }
    if (allowFileChanges) {
      args.push("--force");
    }
    args.push(prompt);

    const env = { ...process.env };
    const proc = child_process.spawn(AGENT_CMD, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      channel.append(text);
      onOutput?.(text, "stdout");
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      channel.append(text);
      onOutput?.(text, "stderr");
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "ENOENT"
          ? `Command "${AGENT_CMD}" not found. Install Cursor CLI: https://cursor.com/docs/cli/installation (e.g. irm 'https://cursor.com/install?win32=true' | iex on Windows) and ensure CURSOR_API_KEY is set for headless use.`
          : (err.message || String(err));
      channel.appendLine(`Error: ${msg}`);
      resolve({ success: false, error: msg });
    });

    proc.on("close", (code, signal) => {
      channel.appendLine("");
      channel.appendLine(`Process exited with code ${code ?? signal ?? "unknown"}`);
      resolve({ success: code === 0 });
    });
  });
}

export function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const uri = folders[0].uri;
  if (uri.scheme === "file") return path.normalize(uri.fsPath);
  return null;
}
