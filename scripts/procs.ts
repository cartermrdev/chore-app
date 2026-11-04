// Small process helpers shared by scripts/dev.ts and scripts/e2e.ts.
import type { Subprocess } from "bun";

/** Asks the OS for a free TCP port. */
export function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

const stopping = new Set<number>();

export function start(name: string, cmd: string[], opts: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {}): Subprocess {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: opts.quiet ? "ignore" : "inherit",
    stderr: "inherit",
  });
  proc.exited.then((code) => {
    if (code !== 0 && code !== null && !stopping.has(proc.pid)) console.error(`[${name}] exited with ${code}`);
  });
  return proc;
}

/** Kills a process and its children (vite spawns node/esbuild on Windows). */
export async function stop(proc: Subprocess): Promise<void> {
  if (proc.exitCode !== null) return;
  stopping.add(proc.pid);
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  } else {
    proc.kill("SIGTERM");
  }
  await Promise.race([proc.exited, Bun.sleep(5000)]);
}

export async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
