/** What a sandbox is asked to run. The worktree is the only thing it can see. */
export interface ExecRequest {
  /** Unique per call; used as the container name so it can be killed. */
  name: string;
  /** The run's worktree on the host. Mounted read-write at /work. */
  root: string;
  /** Paths relative to root that are mounted read-only. */
  protectedPaths: string[];
  /** Working directory relative to root; empty means the root. */
  cwd: string;
  command: string;
  /** Seconds. Fractions are allowed so tests can use short limits. */
  timeoutS: number;
  /** Only "off" exists today. Named hosts through a logging proxy come later. */
  network: "off";
}

export interface ExecResult {
  /** Null when the process was killed before it could exit. */
  exitCode: number | null;
  /** Standard output and error, in the order they arrived, cut at the byte limit. */
  output: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface Sandbox {
  /** Runs one shell command. Rejects only when the sandbox itself cannot run. */
  exec(req: ExecRequest, signal: AbortSignal): Promise<ExecResult>;
}

/** Starting limits from the design. Tighten or loosen per project later. */
export interface DockerConfig {
  dockerBin: string;
  image: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  /** Size of the writable /tmp. The root filesystem itself is read-only. */
  tmpfsMb: number;
  /** Output kept per command. */
  outputBytes: number;
  /** User id and group id the command runs as. Never root. */
  user: string;
}

export const DEFAULT_DOCKER_CONFIG: DockerConfig = {
  dockerBin: "docker",
  image: "node:22-slim",
  cpus: 2,
  memoryMb: 2048,
  pids: 256,
  tmpfsMb: 512,
  outputBytes: 200 * 1024,
  user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
};
