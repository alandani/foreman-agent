import fs from "node:fs";
import path from "node:path";
import type { ToolError } from "./types.js";

export type PathResult = { ok: true; abs: string } | ToolError;

/**
 * Gateway check 5 (project root): resolve a model-supplied path and make sure it
 * stays inside the run's worktree, including through symlinks.
 * The path must be relative to the root.
 */
export function resolveInside(root: string, requested: string): PathResult {
  const fail = (message: string): ToolError => ({
    ok: false,
    code: "path_outside_project",
    message,
    hint: "Use a path relative to the project root, such as src/app.ts.",
  });

  if (requested.length === 0 || requested.includes("\0")) {
    return fail("The path is empty or contains invalid characters.");
  }
  if (path.isAbsolute(requested)) {
    return fail(`${requested} is an absolute path.`);
  }

  const realRoot = fs.realpathSync(root);
  const lexical = path.resolve(realRoot, requested);
  if (!isInside(realRoot, lexical)) {
    return fail(`${requested} is outside the project root.`);
  }

  // Follow symlinks on the deepest part that exists, so a link cannot lead out.
  let probe = lexical;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (!isInside(realRoot, realProbe)) {
    return fail(`${requested} leads outside the project root through a link.`);
  }
  // Checks run against the real root, but callers measure paths against the
  // root they passed in, so return the path under that root.
  return { ok: true, abs: path.resolve(root, path.relative(realRoot, lexical)) };
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
