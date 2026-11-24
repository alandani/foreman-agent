import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../gateway/definition.js";
import type { Handler } from "../gateway/pipeline.js";

/** Directories no file tool lists, searches or touches. */
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_READ_LINES = 2000;
const MAX_LIST_ENTRIES = 500;
const MAX_LINE_CHARS = 200;

const base: Pick<ToolDefinition, "scope" | "version" | "pathFields"> = {
  scope: "project_files",
  version: 1,
  pathFields: ["path"],
};

export const fileTools: ToolDefinition[] = [
  {
    ...base,
    name: "list_files",
    description:
      "Lists files and folders under a project folder, one path per line, folders ending in a slash. Skips .git and node_modules. Use it to find your way around before reading.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", maxLength: 300 },
        depth: { type: "integer", minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
    risk: "safe",
    timeoutS: 15,
    maxOutputTokens: 3000,
    idempotent: true,
  },
  {
    ...base,
    name: "read_file",
    description:
      "Reads a text file, or a line range of it, and returns numbered lines. Returns at most 2000 lines per call; use startLine and endLine for more. Refuses binary files and files over 1 MB.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", maxLength: 300 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    risk: "safe",
    timeoutS: 15,
    maxOutputTokens: 8000,
    idempotent: true,
  },
  {
    ...base,
    name: "search_code",
    description:
      "Searches text files for a literal string, or a regular expression when regex is true. Returns path:line: text for each match, at most maxResults. Searches the whole project unless path is given.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, maxLength: 300 },
        path: { type: "string", maxLength: 300 },
        regex: { type: "boolean" },
        ignoreCase: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    risk: "safe",
    timeoutS: 30,
    maxOutputTokens: 4000,
    idempotent: true,
  },
  {
    ...base,
    name: "edit_file",
    description:
      "Replaces one exact piece of text in an existing file. oldText must match exactly one place, so include enough surrounding lines to be unique. Fails if the text is missing or appears more than once.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", maxLength: 300 },
        oldText: { type: "string", minLength: 1, maxLength: 20000 },
        newText: { type: "string", maxLength: 20000 },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    risk: "contained",
    timeoutS: 15,
    maxOutputTokens: 500,
    idempotent: false,
    writes: true,
  },
  {
    ...base,
    name: "write_file",
    description:
      "Creates a file or replaces it completely with the given content, creating folders as needed. Prefer edit_file for small changes to an existing file. Cannot write inside .git.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", maxLength: 300 },
        content: { type: "string", maxLength: 200000 },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    risk: "contained",
    timeoutS: 15,
    maxOutputTokens: 500,
    idempotent: false,
    writes: true,
  },
];

function rel(root: string, abs: string): string {
  return path.relative(root, abs) || ".";
}

function insideGit(root: string, abs: string): boolean {
  return rel(root, abs).split(path.sep).includes(".git");
}

async function statOrThrow(root: string, abs: string): Promise<fs.Stats> {
  try {
    return await fs.promises.stat(abs);
  } catch {
    throw new Error(`${rel(root, abs)} does not exist.`);
  }
}

/** Reads a text file, refusing big or binary ones. */
async function readText(root: string, abs: string): Promise<string> {
  const st = await statOrThrow(root, abs);
  if (st.isDirectory()) throw new Error(`${rel(root, abs)} is a folder, not a file.`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`${rel(root, abs)} is ${st.size} bytes, over the 1 MB limit.`);
  }
  const buf = await fs.promises.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${rel(root, abs)} looks like a binary file.`);
  return buf.toString("utf8");
}

/** Every regular file under a folder, in a stable order. Symlinks are not followed. */
async function* walk(dir: string, signal: AbortSignal): AsyncGenerator<string> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (signal.aborted) throw new Error("Search was stopped.");
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, signal);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

export function fileHandlers(root: string): Record<string, Handler> {
  const list_files: Handler = async (args, env) => {
    const start = env.paths["path"] ?? root;
    const depth = typeof args["depth"] === "number" ? args["depth"] : 2;
    const st = await statOrThrow(root, start);
    if (!st.isDirectory()) throw new Error(`${rel(root, start)} is a file, not a folder.`);

    const lines: string[] = [];
    let more = false;
    const visit = async (dir: string, level: number): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
        if (lines.length >= MAX_LIST_ENTRIES) {
          more = true;
          return;
        }
        const full = path.join(dir, e.name);
        const name = rel(root, full);
        if (e.isDirectory()) {
          lines.push(`${name}/`);
          if (level < depth) await visit(full, level + 1);
        } else if (e.isFile()) {
          lines.push(name);
        }
      }
    };
    await visit(start, 1);
    if (lines.length === 0) return `${rel(root, start)} is empty.`;
    if (more) lines.push(`(more than ${MAX_LIST_ENTRIES} entries; narrow the path or lower the depth)`);
    return lines.join("\n");
  };

  const read_file: Handler = async (args, env) => {
    const abs = env.paths["path"]!;
    if (insideGit(root, abs)) throw new Error("Files inside .git are not readable.");
    const text = await readText(root, abs);
    const all = text.split("\n");
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    const total = all.length;
    const from = typeof args["startLine"] === "number" ? args["startLine"] : 1;
    if (total === 0) return `${rel(root, abs)} is empty.`;
    if (from > total) throw new Error(`${rel(root, abs)} has only ${total} lines.`);
    const requestedEnd = typeof args["endLine"] === "number" ? args["endLine"] : from + MAX_READ_LINES - 1;
    if (requestedEnd < from) throw new Error("endLine is before startLine.");
    const to = Math.min(requestedEnd, total, from + MAX_READ_LINES - 1);
    const body = all
      .slice(from - 1, to)
      .map((line, i) => `${from + i}\t${line}`)
      .join("\n");
    const note = to < total ? ` (more lines follow; continue at line ${to + 1})` : "";
    return `${rel(root, abs)}, lines ${from}-${to} of ${total}${note}\n${body}`;
  };

  const search_code: Handler = async (args, env) => {
    const start = env.paths["path"] ?? root;
    const pattern = String(args["pattern"]);
    const ignoreCase = args["ignoreCase"] === true;
    const limit = typeof args["maxResults"] === "number" ? args["maxResults"] : 50;
    let re: RegExp;
    try {
      const source = args["regex"] === true ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(source, ignoreCase ? "i" : "");
    } catch {
      throw new Error("The pattern is not a valid regular expression.");
    }

    const st = await statOrThrow(root, start);
    const files = st.isDirectory() ? walk(start, env.signal) : (async function* () { yield start; })();
    const hits: string[] = [];
    let capped = false;
    outer: for await (const file of files) {
      let text: string;
      try {
        text = await readText(root, file);
      } catch {
        continue; // binary, too big or unreadable: skip quietly
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.length > 2000) continue;
        if (re.test(line)) {
          if (hits.length >= limit) {
            capped = true;
            break outer;
          }
          const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
          hits.push(`${rel(root, file)}:${i + 1}: ${shown.trim()}`);
        }
      }
    }
    if (hits.length === 0) return "No matches.";
    if (capped) hits.push(`(stopped at ${limit} results; narrow the pattern or the path)`);
    return hits.join("\n");
  };

  const edit_file: Handler = async (args, env) => {
    const abs = env.paths["path"]!;
    if (insideGit(root, abs)) throw new Error("Files inside .git cannot be changed.");
    const oldText = String(args["oldText"]);
    const newText = String(args["newText"]);
    const text = await readText(root, abs);
    const first = text.indexOf(oldText);
    if (first === -1) throw new Error(`oldText was not found in ${rel(root, abs)}. Read the file again and copy the text exactly.`);
    if (text.indexOf(oldText, first + 1) !== -1) {
      throw new Error(`oldText appears more than once in ${rel(root, abs)}. Include more surrounding lines so it matches one place.`);
    }
    const updated = text.slice(0, first) + newText + text.slice(first + oldText.length);
    await writeAtomic(abs, updated);
    const removed = oldText.split("\n").length;
    const added = newText.split("\n").length;
    return `Edited ${rel(root, abs)}: replaced ${removed} line(s) with ${added}.`;
  };

  const write_file: Handler = async (args, env) => {
    const abs = env.paths["path"]!;
    if (insideGit(root, abs)) throw new Error("Files inside .git cannot be changed.");
    const content = String(args["content"]);
    let existed = false;
    try {
      const st = await fs.promises.stat(abs);
      if (st.isDirectory()) throw new Error(`${rel(root, abs)} is a folder.`);
      existed = true;
    } catch (err) {
      if (err instanceof Error && err.message.endsWith("is a folder.")) throw err;
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await writeAtomic(abs, content);
    return `${existed ? "Replaced" : "Created"} ${rel(root, abs)} (${Buffer.byteLength(content)} bytes).`;
  };

  return { list_files, read_file, search_code, edit_file, write_file };
}

/** Writes beside the target and renames, so a crash never leaves half a file. */
async function writeAtomic(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content, "utf8");
    await fs.promises.rename(tmp, abs);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}
