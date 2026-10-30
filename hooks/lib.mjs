import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function emit(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function recallBinary() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, "recall"))) return path.join(dir, "recall");
  }
  const cargo = path.join(homedir(), ".cargo", "bin", "recall");
  return existsSync(cargo) ? cargo : undefined;
}

export function firstLine(text) {
  return String(text).trim().split("\n").find(Boolean) ?? "";
}

export function stateDir() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(stateHome, "recall");
}

export function logRun(sessionId, outcome, started) {
  const dir = stateDir();
  const line = [new Date().toISOString(), sessionId ?? "-", outcome, `${Date.now() - started}ms`].join(" ");
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "hooks.log"), `${line}\n`);
  } catch {
    // A failing log must never change how the hook behaves.
  }
}

export function recall(args, { cwd, timeout, input }) {
  const binary = recallBinary();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      error: "recall CLI not found on PATH or in ~/.cargo/bin; see https://github.com/mvhenten/recall#install",
    });
  }
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  return new Promise((resolve) => {
    const child = execFile(binary, args, { cwd: dir, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout });
      if (error.killed) return resolve({ ok: false, timedOut: true, error: `timed out after ${timeout} ms` });
      resolve({ ok: false, error: firstLine(stderr) || error.message });
    });
    if (input === undefined) return;
    // recall may exit before reading stdin; the exit callback above reports that failure.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
