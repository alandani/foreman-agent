import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox } from "../../src/sandbox/docker.js";
import { DEFAULT_DOCKER_CONFIG, type ExecRequest } from "../../src/sandbox/sandbox.js";

/**
 * Real containers. These run only when Docker is up and the image is already
 * pulled (docker pull node:22-slim). Set FOREMAN_SKIP_DOCKER=1 to skip them.
 */
function dockerReady(): boolean {
  if (process.env["FOREMAN_SKIP_DOCKER"] === "1") return false;
  const bin = DEFAULT_DOCKER_CONFIG.dockerBin;
  const info = spawnSync(bin, ["info"], { timeout: 8000 });
  if (info.status !== 0) return false;
  return spawnSync(bin, ["image", "inspect", DEFAULT_DOCKER_CONFIG.image], { timeout: 8000 }).status === 0;
}
const ready = dockerReady();

describe.skipIf(!ready)("DockerSandbox with real containers", () => {
  let root: string;
  let n = 0;
  const sandbox = new DockerSandbox();
  beforeAll(() => {
    // Resolve the real path: /tmp is a symlink on macOS and Docker mounts need the true one.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foreman-dock-")));
    fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(path.join(root, "tests/t.test.ts"), "original");
    fs.writeFileSync(path.join(root, "hello.txt"), "hi from host");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (command: string, over: Partial<ExecRequest> = {}) =>
    sandbox.exec(
      { name: `foreman-it-${process.pid}-${++n}`, root, protectedPaths: ["tests"], cwd: "", command, timeoutS: 60, network: "off", ...over },
      new AbortController().signal,
    );

  it("runs a command and returns its output and exit code", async () => {
    const r = await run("echo hello && exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("hello");
  });
  it("sees the worktree and can write to it", async () => {
    const r = await run("cat hello.txt && echo made > new.txt");
    expect(r.output).toContain("hi from host");
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf8").trim()).toBe("made");
  });
  it("cannot change protected files", async () => {
    const r = await run("echo hacked > tests/t.test.ts");
    expect(r.exitCode).not.toBe(0);
    expect(fs.readFileSync(path.join(root, "tests/t.test.ts"), "utf8")).toBe("original");
  });
  it("has no network", async () => {
    const r = await run(`node -e "fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(7))"`);
    expect(r.exitCode).toBe(7);
  });
  it("does not see the host environment or the rest of the disk", async () => {
    process.env["FOREMAN_TEST_SECRET"] = "s3cret-value";
    try {
      const r = await run("env; ls /Users 2>&1; echo end");
      expect(r.output).not.toContain("s3cret-value");
      expect(r.output).toMatch(/No such file/);
    } finally {
      delete process.env["FOREMAN_TEST_SECRET"];
    }
  });
  it("is not root and has a read-only system", async () => {
    const r = await run("id -u; touch /usr/x 2>&1; echo done");
    expect(r.output.split("\n")[0]).not.toBe("0");
    expect(r.output).toMatch(/Read-only|denied/i);
  });
  it("kills a command that runs too long", async () => {
    const r = await run("sleep 30", { timeoutS: 2 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(15000);
  });
  it("caps runaway output", async () => {
    const r = await run(`node -e "process.stdout.write('x'.repeat(1_000_000))"`);
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(DEFAULT_DOCKER_CONFIG.outputBytes);
  });
  it("limits processes so a fork bomb cannot take the machine", async () => {
    const r = await run(`for i in $(seq 1 400); do sleep 5 & done 2>&1 | tail -1; echo finished`, { timeoutS: 20 });
    expect(r.output).toContain("finished");
  });
});
