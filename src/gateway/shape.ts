/** Rough token estimate: about four characters per token. */
export const CHARS_PER_TOKEN = 4;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
];

/** Removes known secret values and common secret patterns. A safety net, not the main control. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export interface Shaped {
  body: string;
  truncated: boolean;
}

/**
 * Cleans and caps a tool result. Strips colour codes and progress lines, collapses
 * blank runs, and keeps the start and the end of long output because errors sit at the end.
 */
export function shape(raw: string, maxTokens: number): Shaped {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map(lastRewrite)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const cap = maxTokens * CHARS_PER_TOKEN;
  if (cleaned.length <= cap) return { body: cleaned, truncated: false };

  const head = Math.floor(cap * 0.7);
  const tail = cap - head;
  const dropped = cleaned.length - head - tail;
  const marker = `\n[... ${dropped} characters dropped; narrow the query or read a line range ...]\n`;
  return { body: cleaned.slice(0, head) + marker + cleaned.slice(cleaned.length - tail), truncated: true };
}

/** Keeps only the final rewrite of a line (progress bars use carriage returns). Linear time. */
function lastRewrite(line: string): string {
  const end = line.endsWith("\r") ? line.slice(0, -1) : line;
  const i = end.lastIndexOf("\r");
  return i === -1 ? end : end.slice(i + 1);
}
