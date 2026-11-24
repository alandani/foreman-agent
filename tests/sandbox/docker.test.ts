import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containerName, DockerSandbox, dockerArgs, type SpawnFn } from "../../src/sandbox/docker.js";
import { DEFAULT_DOCKER_CONFIG, type ExecRequest } from "../../src/sandbox/sandbox.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-sbx-"));
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  name: "foreman-r1-1",
  root,
  protectedPaths: ["tests", "package.json", "missing-dir"],
  cwd: "",
  command: "echo hi",
  timeoutS: 5,
  network: "off",
  ...over,
});

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

describe("dockerArgs", () => {
  const args = () => dockerArgs(DEFAULT_DOCKER_CONFIG, req());
  it("turns the network off", () => expect(flag(args(), "--network")).toBe("none"));
  it("applies the starting limits", () => {
    const a = args();
    expect(flag(a, "--cpus")).toBe("2");
    expect(flag(a, "--memory")).toBe("2048m");
    expect(flag(a, "--memory-swap")).toBe("2048m");
    expect(flag(a, "--pids-limit")).toBe("256");
  });
  it("drops all capabilities and blocks privilege gain", () => {
    const a = args();
    expect(flag(a, "--cap-drop")).toBe("ALL");
    expect(flag(a, "--security-opt")).toBe("no-new-privileges");
  });
  it("makes the root filesystem read-only with a small writable /tmp", () => {
    const a = args();
    expect(a).toContain("--read-only");
    expect(flag(a, "--tmpfs")).toBe("/tmp:rw,size=512m");
  });
  it("never runs as root", () => {
    const user = flag(args(), "--user")!;
    expect(user).toMatch(/^\d+:\d+$/);
    expect(user.startsWith("0:")).toBe(false);
  });
  it("passes no host environment, only HOME", () => {
    const a = args();
    const envFlags = a.flatMap((x, i) => (x === "-e" ? [a[i + 1]] : []));
    expect(envFlags).toEqual(["HOME=/tmp"]);
    expect(a).not.toContain("--env-file");
  });
  it("mounts the worktree read-write and layers protected paths read-only", () => {
    const mounts = args().flatMap((x, i, all) => (x === "--mount" ? [all[i + 1]!] : []));
    expect(mounts[0]).toBe(`type=bind,source=${root},target=/work`);
    expect(mounts).toContain(`type=bind,source=${path.join(root, "tests")},target=/work/tests,readonly`);
    expect(mounts).toContain(`type=bind,source=${path.join(root, "package.json")},target=/work/package.json,readonly`);
  });
  it("skips protected paths that do not exist", () => {
    expect(args().join(" ")).not.toContain("missing-dir");
  });
  it("mounts nothing else from the host", () => {
    const mounts = args().flatMap((x, i, all) => (x === "--mount" ? [all[i + 1]!] : []));
    expect(mounts.every((m) => m.includes(root))).toBe(true);
    expect(args()).not.toContain("-v");
    expect(args()).not.toContain("--privileged");
  });
  it("sets the working directory inside /work", () => {
    expect(flag(args(), "--workdir")).toBe("/work");
    expect(flag(dockerArgs(DEFAULT_DOCKER_CONFIG, req({ cwd: "src/deep" })), "--workdir")).toBe("/work/src/deep");
  });
  it("ends with the image and the command as one shell argument", () => {
    const a = dockerArgs(DEFAULT_DOCKER_CONFIG, req({ command: "echo 'a b'; ls" }));
    expect(a.slice(-4)).toEqual(["node:22-slim", "sh", "-c", "echo 'a b'; ls"]);
  });
  it("ignores protected paths that try to leave the project", () => {
    const a = dockerArgs(DEFAULT_DOCKER_CONFIG, req({ protectedPaths: ["../etc", "/etc"] }));
    expect(a.filter((x) => x.includes("readonly"))).toEqual([]);
  });
  it("refuses a project path Docker could misread", () => {
    expect(() => dockerArgs(DEFAULT_DOCKER_CONFIG, req({ root: "/tmp/a,b" }))).toThrow(/comma/);
  });
});

describe("containerName", () => {
  it("makes a safe name from the idempotency key", () => {
    expect(containerName("Run 1:7")).toBe("foreman-run-1-7");
    expect(containerName(":::")).toBe("foreman-");
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(sig?: string) {
    this.killed.push(sig ?? "SIGTERM");
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const calls: string[][] = [];
  const fn: SpawnFn = (_cmd, args) => {
    calls.push(args);
    const c = new FakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  return { fn, children, calls };
}

describe("DockerSandbox.exec", () => {
  it("returns the exit code and output in arrival order", async () => {
    const s = fakeSpawn();
    const p = new DockerSandbox({}, s.fn).exec(req(), new AbortController().signal);
    s.children[0]!.stdout.write("one\n");
    s.children[0]!.stderr.write("two\n");
    s.children[0]!.emit("close", 3);
    const r = await p;
    expect(r).toMatchObject({ exitCode: 3, output: "one\ntwo\n", timedOut: false, truncated: false });
  });
  it("cuts output at the byte limit and says so", async () => {
    const s = fakeSpawn();
    const p = new DockerSandbox({ outputBytes: 10 }, s.fn).exec(req(), new AbortController().signal);
    s.children[0]!.stdout.write("0123456789ABCDEF");
    s.children[0]!.stdout.write("more");
    s.children[0]!.emit("close", 0);
    const r = await p;
    expect(r.output).toBe("0123456789");
    expect(r.truncated).toBe(true);
  });
  it("kills the container and the client on timeout", async () => {
    const s = fakeSpawn();
    const r = await new DockerSandbox({}, s.fn).exec(req({ timeoutS: 0.02 }), new AbortController().signal);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(s.calls.some((a) => a[0] === "kill" && a[1] === "foreman-r1-1")).toBe(true);
    expect(s.children[0]!.killed).toContain("SIGKILL");
  });
  it("kills when the gateway aborts the call", async () => {
    const s = fakeSpawn();
    const ctl = new AbortController();
    const p = new DockerSandbox({}, s.fn).exec(req({ timeoutS: 60 }), ctl.signal);
    ctl.abort();
    await p;
    expect(s.calls.some((a) => a[0] === "kill")).toBe(true);
  });
  it("says plainly when Docker is not installed", async () => {
    const s = fakeSpawn();
    const p = new DockerSandbox({}, s.fn).exec(req(), new AbortController().signal);
    s.children[0]!.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    await expect(p).rejects.toThrow(/Docker was not found/);
  });
  it("treats exit 125 as Docker failing, not the command", async () => {
    const s = fakeSpawn();
    const p = new DockerSandbox({}, s.fn).exec(req(), new AbortController().signal);
    s.children[0]!.stderr.write("Cannot connect to the Docker daemon");
    s.children[0]!.emit("close", 125);
    await expect(p).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });
  it("passes a command's own exit 126 and 127 through as results", async () => {
    const s = fakeSpawn();
    const p = new DockerSandbox({}, s.fn).exec(req(), new AbortController().signal);
    s.children[0]!.emit("close", 127);
    expect((await p).exitCode).toBe(127);
  });
  it("does not leak the abort listener after finishing", async () => {
    const s = fakeSpawn();
    const ctl = new AbortController();
    const p = new DockerSandbox({}, s.fn).exec(req(), ctl.signal);
    s.children[0]!.emit("close", 0);
    await p;
    ctl.abort();
    expect(s.calls.filter((a) => a[0] === "kill")).toHaveLength(0);
  });
});
