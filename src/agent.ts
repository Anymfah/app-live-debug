import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Relative path to the prompt file (agent reads it via tool when we reference it in the prompt). */
const PROMPT_FILE_REL = ".cursor/app-live-debug-prompt.txt";

const OUTPUT_CHANNEL_NAME = "App Live Debug (Agent)";
const AGENT_CMD = "agent";

export interface RunAgentOptions {
  prompt: string;
  cwd: string;
  allowFileChanges: boolean;
  /** Model to use (e.g. "auto", "gpt-5.2", "sonnet-4.5-thinking"). Empty string = do not pass --model. */
  model?: string;
  /** Cursor API key for headless use. When set, overrides CURSOR_API_KEY env var. */
  cursorApiKey?: string;
  /** Full path to the agent executable. When set, used instead of "agent" from PATH. */
  agentPath?: string;
  /** Workspace trust: value from settings (e.g. "Trust workspace (recommended)") maps to --trust, --yolo, or no flag. */
  workspaceTrust?: string;
  /** When set, pass --resume <contextId> to continue that chat (enables multiple chat windows; each window sends its own contextId). */
  contextId?: string;
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
  const { prompt, cwd, allowFileChanges, model, cursorApiKey, agentPath, workspaceTrust, contextId: resumeContextId, onOutput } = options;
  const channel = getOutputChannel();
  channel.clear();
  const executable = (agentPath && agentPath.trim()) || AGENT_CMD;
  const trustFlag =
    workspaceTrust?.includes("yolo")
      ? "yolo"
      : workspaceTrust?.includes("Ask each time")
        ? undefined
        : "trust";
  channel.appendLine(`[App Live Debug] Running Cursor agent (headless) in ${cwd}`);
  if (agentPath && agentPath.trim()) channel.appendLine(`Using agent: ${executable}`);
  if (trustFlag) channel.appendLine(`Workspace trust: ${trustFlag} (--${trustFlag})`);
  if (resumeContextId) channel.appendLine(`Resume chat: ${resumeContextId} (--resume)`);
  const keyToUse = cursorApiKey?.trim() || process.env.CURSOR_API_KEY || "";
  if (keyToUse) {
    const masked = keyToUse.length > 12 ? `${keyToUse.slice(0, 8)}...${keyToUse.slice(-4)}` : "***";
    channel.appendLine(`Using CURSOR_API_KEY: ${masked} (from ${cursorApiKey?.trim() ? "settings" : "environment"})`);
  } else {
    channel.appendLine("Warning: CURSOR_API_KEY not set (neither in settings nor in env)");
  }
  if (model) channel.appendLine(`Model: ${model}`);
  channel.appendLine(`Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`);
  channel.appendLine("");

  // Per Cursor headless docs: "mentionnez les chemins de fichiers dans le texte de votre prompt. L'agent lira automatiquement les fichiers".
  // Write full prompt to file and pass a short prompt that references it — avoids quoting/encoding issues with long or HTML-heavy content.
  const cursorDir = path.join(cwd, ".cursor");
  const promptFilePath = path.join(cursorDir, "app-live-debug-prompt.txt");
  const keyFilePath = path.join(cursorDir, "app-live-debug-key.txt");
  try {
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(promptFilePath, prompt, "utf8");
  } catch (e) {
    channel.appendLine(`Error writing prompt file: ${(e as Error).message}`);
    return Promise.resolve({ success: false, error: (e as Error).message });
  }

  const promptToPass = `Read and follow the full instructions and context from this file: ${PROMPT_FILE_REL}. Do not confirm that you read the file or image; proceed directly with the requested task.`;
  let keyFileToDelete: string | null = null;
  if (keyToUse) {
    try {
      fs.writeFileSync(keyFilePath, keyToUse, "utf8");
      keyFileToDelete = keyFilePath;
    } catch (e) {
      channel.appendLine(`Error writing key file: ${(e as Error).message}`);
      return Promise.resolve({ success: false, error: (e as Error).message });
    }
  }

  const isPs1 = executable.toLowerCase().endsWith(".ps1");
  const isCmdOrBat =
    process.platform === "win32" &&
    (executable.toLowerCase().endsWith(".cmd") || executable.toLowerCase().endsWith(".bat"));

  const env = { ...process.env };
  if (keyToUse) env.CURSOR_API_KEY = keyToUse;

  const agentArgs: string[] = [];
  if (trustFlag === "trust") agentArgs.push("--trust");
  else if (trustFlag === "yolo") agentArgs.push("--yolo");
  if (resumeContextId) agentArgs.push("--resume", resumeContextId);
  agentArgs.push("-p", promptToPass);
  if (model && model.trim()) agentArgs.push("--model", model.trim());
  if (allowFileChanges) agentArgs.push("--force");

  let runExecutable: string;
  let runArgs: string[];

  if (isPs1) {
    // On Windows, spawn env may not reach the agent; set CURSOR_API_KEY from file in PowerShell before calling agent.ps1.
    const keyPathQuoted = keyFilePath.replace(/'/g, "''");
    const cwdQuoted = cwd.replace(/'/g, "''");
    const scriptPathQuoted = executable.replace(/'/g, "''");
    const setKey = keyToUse
      ? `$env:CURSOR_API_KEY = (Get-Content -LiteralPath '${keyPathQuoted}' -Raw -Encoding UTF8).Trim(); `
      : "";
    const argsStr = agentArgs.map((a) => (a.includes(" ") ? `'${a.replace(/'/g, "''")}'` : a)).join(" ");
    const cmd = `$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath '${cwdQuoted}'; ${setKey}& '${scriptPathQuoted}' ${argsStr} 2>&1`;
    runExecutable = "powershell";
    runArgs = ["-ExecutionPolicy", "Bypass", "-NoProfile", "-Command", cmd];
    channel.appendLine(`Prompt in ${PROMPT_FILE_REL} (agent will read it). Key from file if set, deleted when run finishes.`);
  } else {
    runExecutable = executable;
    runArgs = agentArgs;
  }

  const cmdForLog = runArgs.map((a) => (a.length > 100 ? `${a.slice(0, 97)}...` : a)).join(" ");
  channel.appendLine(`Full command: ${runExecutable} ${cmdForLog}`);
  channel.appendLine("");

  return new Promise((resolve) => {
    const proc = child_process.spawn(runExecutable, runArgs, {
      cwd,
      env,
      shell: isCmdOrBat,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const isClixml = (s: string) => /#<\s*CLIXML/i.test(s) || /<Objs\s+Version=/i.test(s);
    const filterOutput = (text: string): string =>
      isClixml(text) ? "[PowerShell progress output suppressed]\n" : text;

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      const out = filterOutput(text);
      if (out) {
        channel.append(out);
        onOutput?.(out, "stdout");
      }
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      const out = filterOutput(text);
      if (out) {
        channel.append(out);
        onOutput?.(out, "stderr");
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "ENOENT"
          ? `Command "${runExecutable}" not found. Install Cursor CLI: https://cursor.com/docs/cli/installation (e.g. irm 'https://cursor.com/install?win32=true' | iex on Windows). If installed, set "App Live Debug: Agent Path" to the full path (e.g. ...\\agent.ps1 or ...\\agent.cmd; run 'where agent' in a terminal to get it).`
          : (err.message || String(err));
      channel.appendLine(`Error: ${msg}`);
      resolve({ success: false, error: msg });
    });

    proc.on("close", (code, signal) => {
      if (keyFileToDelete) {
        try {
          fs.unlinkSync(keyFileToDelete);
        } catch (_e) {
          // ignore if already deleted or missing
        }
        keyFileToDelete = null;
      }
      channel.appendLine("");
      channel.appendLine(`Process exited with code ${code ?? signal ?? "unknown"}`);
      if (code !== 0 && code != null) {
        channel.appendLine("Check the output above for agent errors, or run the logged command in a terminal to see the full error.");
      }
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
