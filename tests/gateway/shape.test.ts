import { describe, expect, it } from "vitest";
import { scrub, shape } from "../../src/gateway/shape.js";

describe("scrub", () => {
  it("removes known secret values", () => {
    expect(scrub("token is s3cr3t-value here", ["s3cr3t-value"])).toBe("token is [redacted] here");
  });
  it("removes every occurrence", () => {
    expect(scrub("abcd abcd", ["abcd"])).toBe("[redacted] [redacted]");
  });
  it("ignores very short secrets that would damage the text", () => {
    expect(scrub("a b c", ["a"])).toBe("a b c");
  });
  it("removes private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(scrub(`before ${key} after`, [])).toBe("before [redacted] after");
  });
  it("removes bearer tokens", () => {
    expect(scrub("Authorization: Bearer abcdefghijklmnop1234", [])).toBe("Authorization: [redacted]");
  });
  it("removes cloud access keys", () => {
    expect(scrub("key AKIAABCDEFGHIJKLMNOP end", [])).toBe("key [redacted] end");
  });
});

describe("shape", () => {
  it("leaves short output alone", () => {
    expect(shape("hello", 100)).toEqual({ body: "hello", truncated: false });
  });
  it("strips colour codes", () => {
    expect(shape("\u001b[31mred\u001b[0m", 100).body).toBe("red");
  });
  it("drops progress-bar lines rewritten with carriage returns", () => {
    expect(shape("10%\r50%\rdone", 100).body).toBe("done");
  });
  it("keeps text on lines that end with Windows line endings", () => {
    expect(shape("one\r\ntwo\r\n", 100).body).toBe("one\ntwo");
  });
  it("handles one very long line quickly", () => {
    const started = Date.now();
    shape("y".repeat(500_000), 100);
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("collapses runs of blank lines", () => {
    expect(shape("a\n\n\n\n\nb", 100).body).toBe("a\n\nb");
  });
  it("caps long output, keeps start and end, and says how much was dropped", () => {
    const raw = "START" + "x".repeat(10000) + "END";
    const out = shape(raw, 100);
    expect(out.truncated).toBe(true);
    expect(out.body.startsWith("START")).toBe(true);
    expect(out.body.endsWith("END")).toBe(true);
    expect(out.body).toContain("characters dropped");
    expect(out.body.length).toBeLessThan(600);
  });
});
