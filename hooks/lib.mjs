import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

function firstLine(text) {
  return text.trim().split("\n").find(Boolean) ?? "";
}

export function recall(args, { cwd, timeout }) {
  const binary = recallBinary();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      error: "recall CLI not found on PATH or in ~/.cargo/bin; see https://github.com/mvhenten/recall#install",
    });
  }
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  return new Promise((resolve) => {
    execFile(binary, args, { cwd: dir, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout });
      if (error.killed) return resolve({ ok: false, error: `timed out after ${timeout} ms` });
      resolve({ ok: false, error: firstLine(stderr) || error.message });
    });
  });
}
