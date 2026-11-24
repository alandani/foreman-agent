import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DOCKER_CONFIG, type DockerConfig, type ExecRequest, type ExecResult, type Sandbox } from "./sandbox.js";

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

/** Container names must be simple; anything else becomes a dash. */
export function containerName(key: string): string {
  const clean = key.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return `foreman-${clean}`.slice(0, 120);
}

/**
 * The full `docker run` argument list, built in one place so every limit can be
 * checked by a test without Docker. Nothing from the host environment is passed in.
 */
export function dockerArgs(cfg: DockerConfig, req: ExecRequest): string[] {
  if (/[,\n]/.test(req.root)) throw new Error("The project path contains a comma or a newline, which Docker mounts cannot express.");
  const cwd = req.cwd === "" || req.cwd === "." ? "" : req.cwd;
  const args = [
    "run",
    "--rm",
    "--init",
    "--name", req.name,
    "--network", "none",
    "--cpus", String(cfg.cpus),
    "--memory", `${cfg.memoryMb}m`,
    "--memory-swap", `${cfg.memoryMb}m`,
    "--pids-limit", String(cfg.pids),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", `/tmp:rw,size=${cfg.tmpfsMb}m`,
    "--user", cfg.user,
    "-e", "HOME=/tmp",
    "--mount", `type=bind,source=${req.root},target=/work`,
  ];
  // Protected files are laid over the writable mount as read-only.
  for (const rel of req.protectedPaths) {
    const clean = rel.replace(/^\.\//, "").replace(/\/+$/, "");
    if (clean === "" || clean.startsWith("..") || path.isAbsolute(clean)) continue;
    const source = path.join(req.root, clean);
    if (!fs.existsSync(source)) continue;
    if (/[,\n]/.test(source)) continue;
    args.push("--mount", `type=bind,source=${source},target=/work/${clean},readonly`);
  }
  args.push("--workdir", cwd === "" ? "/work" : `/work/${cwd}`, cfg.image, "sh", "-c", req.command);
  return args;
}

export class DockerSandbox implements Sandbox {
  private readonly cfg: DockerConfig;
  constructor(
    cfg: Partial<DockerConfig> = {},
    private readonly spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn,
  ) {
    this.cfg = { ...DEFAULT_DOCKER_CONFIG, ...cfg };
  }

  exec(req: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
    const args = dockerArgs(this.cfg, req);
    const started = Date.now();
    return new Promise<ExecResult>((resolve, reject) => {
      const child = this.spawnFn(this.cfg.dockerBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let kept = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const take = (data: Buffer) => {
        const room = this.cfg.outputBytes - kept;
        if (room <= 0) {
          truncated = true;
          return;
        }
        if (data.length > room) {
          chunks.push(data.subarray(0, room));
          kept += room;
          truncated = true;
        } else {
          chunks.push(data);
          kept += data.length;
        }
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);

      const kill = () => {
        // Killing the docker client alone leaves the container running, so kill that too.
        try {
          this.spawnFn(this.cfg.dockerBin, ["kill", req.name], { stdio: ["ignore", "pipe", "pipe"] }).on("error", () => {});
        } catch {
          /* the container may already be gone */
        }
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, req.timeoutS * 1000);
      const onAbort = () => kill();
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fn();
      };

      child.on("error", (err: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            new Error(
              err.code === "ENOENT"
                ? `Docker was not found (${this.cfg.dockerBin}). Install Docker and make sure it is on the PATH.`
                : `Could not start Docker: ${err.message}`,
            ),
          ),
        );
      });
      child.on("close", (code: number | null) => {
        finish(() => {
          const output = Buffer.concat(chunks).toString("utf8");
          // Exit 125 is Docker itself failing (daemon down, bad image), not the command.
          if (code === 125 && !timedOut) {
            reject(new Error(`Docker could not start the container: ${output.trim().slice(0, 500) || "no message"}`));
            return;
          }
          resolve({
            exitCode: timedOut ? null : code,
            output,
            timedOut,
            truncated,
            durationMs: Date.now() - started,
          });
        });
      });
    });
  }
}
