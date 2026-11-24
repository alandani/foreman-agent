import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../gateway/definition.js";
import type { Handler } from "../gateway/pipeline.js";
import { containerName } from "../sandbox/docker.js";
import type { ExecResult, Sandbox } from "../sandbox/sandbox.js";

export const sandboxTools: ToolDefinition[] = [
  {
    name: "run_shell",
    description:
      "Runs one shell command in the project sandbox and returns its exit code and output. The sandbox sees only this project, has no network and no credentials, and keeps protected files read-only. Long output is trimmed. Commands over the time limit are killed.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 4000 },
        cwd: { type: "string", maxLength: 300 },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["command"],
      additionalProperties: false,
    },
    risk: "contained",
    scope: "sandbox",
    timeoutS: 600,
    maxOutputTokens: 5000,
    idempotent: false,
    version: 1,
    pathFields: ["cwd"],
  },
  {
    name: "run_tests",
    description:
      "Runs the project's test command in the sandbox and returns the exit code and output. Give filter to run part of the suite, such as a file name or test name. Use this instead of run_shell for tests.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", maxLength: 200 },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    risk: "contained",
    scope: "sandbox",
    timeoutS: 600,
    maxOutputTokens: 5000,
    idempotent: false,
    version: 1,
  },
];

export interface SandboxToolOptions {
  root: string;
  protectedPaths: string[];
  sandbox: Sandbox;
  /** The project's test command, for example "npm test --". */
  testCommand: string;
}

/** Single-quote a value so the shell reads it as one literal word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResult(r: ExecResult, timeoutS: number, limitKb: number): string {
  const head = r.timedOut
    ? `Timed out after ${timeoutS} seconds and was killed.`
    : `Exit code: ${r.exitCode ?? "unknown"} (${(r.durationMs / 1000).toFixed(1)}s)`;
  const body = r.output.trim() === "" ? "(no output)" : r.output.replace(/\s+$/, "");
  const note = r.truncated ? `\n(output cut at ${limitKb} KB)` : "";
  return `${head}\n${body}${note}`;
}

export function sandboxHandlers(opts: SandboxToolOptions): Record<string, Handler> {
  const run = async (command: string, cwdAbs: string, timeoutS: number, key: string, signal: AbortSignal) => {
    const result = await opts.sandbox.exec(
      {
        name: containerName(key),
        root: opts.root,
        protectedPaths: opts.protectedPaths,
        cwd: path.relative(opts.root, cwdAbs),
        command,
        timeoutS,
        network: "off",
      },
      signal,
    );
    return formatResult(result, timeoutS, 200);
  };

  const run_shell: Handler = async (args, env) => {
    const cwd = env.paths["cwd"] ?? opts.root;
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(cwd);
    } catch {
      throw new Error(`${path.relative(opts.root, cwd)} does not exist.`);
    }
    if (!st.isDirectory()) throw new Error(`${path.relative(opts.root, cwd)} is a file, not a folder.`);
    const timeout = typeof args["timeoutSeconds"] === "number" ? args["timeoutSeconds"] : 120;
    return run(String(args["command"]), cwd, timeout, env.idempotencyKey, env.signal);
  };

  const run_tests: Handler = async (args, env) => {
    const filter = typeof args["filter"] === "string" && args["filter"] !== "" ? ` ${shellQuote(args["filter"])}` : "";
    const timeout = typeof args["timeoutSeconds"] === "number" ? args["timeoutSeconds"] : 300;
    return run(`${opts.testCommand}${filter}`, opts.root, timeout, env.idempotencyKey, env.signal);
  };

  return { run_shell, run_tests };
}
