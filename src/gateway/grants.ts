import type { ToolDefinition } from "./definition.js";
import { RISKS } from "./definition.js";
import type { Risk, ToolError } from "./types.js";

/** What the registry resolves for one bot version. */
export interface BotVersion {
  /** Tool name to the pinned tool version. */
  tools: Record<string, number>;
  /** Projects this bot may work in. */
  projects: string[];
  /** Tools above this level are refused even if listed. */
  riskCeiling: Risk;
}

export type Registry = ReadonlyMap<string, ToolDefinition>;

export type FindResult = { ok: true; def: ToolDefinition } | ToolError;
export type GrantResult = { ok: true } | ToolError;

const deny = (message: string, hint: string): ToolError => ({
  ok: false,
  code: "not_granted",
  message,
  hint,
});

/**
 * Gateway check 2 (tool exists): the tool is in this bot version's list, at the
 * pinned tool version. The hint names the valid tools and nothing else.
 */
export function findTool(registry: Registry, bot: BotVersion, name: string): FindResult {
  const pinned = bot.tools[name];
  const available = Object.keys(bot.tools).sort().join(", ");
  const hint = `Available tools: ${available}.`;

  if (pinned === undefined) return deny(`Tool ${name} is not available to this bot.`, hint);

  const def = registry.get(name);
  if (!def) return deny(`Tool ${name} is not available to this bot.`, hint);
  if (def.version !== pinned) {
    return deny(`Tool ${name} is not available at the version this bot was tested with.`, hint);
  }
  return { ok: true, def };
}

/**
 * Gateway check 4 (grant): the bot may work in this project and the tool is at
 * or below the bot's risk ceiling.
 */
export function checkGrant(bot: BotVersion, def: ToolDefinition, projectId: string): GrantResult {
  if (!bot.projects.includes(projectId)) {
    return deny("This bot is not granted access to this project.", "Work only in the project of this run.");
  }
  if (RISKS.indexOf(def.risk) > RISKS.indexOf(bot.riskCeiling)) {
    return deny(
      `Tool ${def.name} is above this bot's risk ceiling.`,
      "Use a lower-risk tool or ask the owner.",
    );
  }
  return { ok: true };
}
