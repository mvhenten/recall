import { describe, expect, it } from "vitest";
import { type Chunk, chunkTurnsCarrying, closeChunks, MAX_CHUNK_CHARS } from "../src/chunks";
import { agentName, readTurns } from "../src/turns";

const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);

const prompt = (text: string, at = "2026-11-01T10:00:00.000Z"): string =>
  line({ type: "user", origin: { kind: "human" }, timestamp: at, message: { content: text } });

const answer = (blocks: unknown[], at = "2026-11-01T10:00:01.000Z"): string =>
  line({ type: "assistant", timestamp: at, message: { model: "claude-opus-5", content: blocks } });

describe("reading a transcript", () => {
  it("takes the prompts and the prose, and nothing the machinery wrote", () => {
    const transcript = [
      line({ type: "agent-name", agentName: "kisuvpalas" }),
      prompt("port the offset table to D1"),
      answer([
        { type: "thinking", thinking: "the table is keyed by file" },
        { type: "text", text: "The end of each file lives beside the session." },
        { type: "tool_use", name: "Read", input: { file_path: "/src/transcripts.ts" } },
      ]),
      line({ type: "user", toolUseResult: { stdout: "const OFFSET_DIGITS = 16;" }, message: { content: "ok" } }),
      line({ type: "user", origin: { kind: "hook" }, message: { content: "SessionStart fired" } }),
      line({ type: "user", message: { content: "<system-reminder>be brief</system-reminder>" } }),
      line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "delegated turn" }] } }),
      line({ type: "file-history-snapshot", messageId: "x" }),
      "{ this line does not parse",
    ].join("\n");

    const turns = readTurns(transcript, "main");

    expect(turns).toEqual([
      { speaker: "user", text: "port the offset table to D1", at: Date.parse("2026-11-01T10:00:00.000Z") },
      {
        speaker: "model",
        text: "The end of each file lives beside the session.",
        at: Date.parse("2026-11-01T10:00:01.000Z"),
      },
    ]);
  });

  // A subagent's file is nothing but delegated turns, and the harness marks every entry of it a
  // sidechain — the brief it was given, the prose it answered with, the lot. Read as the session's
  // own file it comes back with no turn in it at all, which is what left the box empty under a
  // note saying the whole file was there.
  it("reads the prose of a delegated file, which is a sidechain from its first entry to its last", () => {
    const delegated = [
      line({
        type: "user",
        isSidechain: true,
        timestamp: "2026-11-01T11:00:00.000Z",
        message: { content: "find why the window stays empty" },
      }),
      line({ type: "attachment", isSidechain: true, attachment: { type: "file", path: "/src/turns.ts" } }),
      line({
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-11-01T11:00:02.000Z",
        message: {
          content: [
            { type: "thinking", thinking: "every entry carries the mark" },
            { type: "text", text: "Every entry of this file is a sidechain." },
            { type: "tool_use", name: "Read", input: { file_path: "/src/turns.ts" } },
          ],
        },
      }),
      line({
        type: "user",
        isSidechain: true,
        toolUseResult: { stdout: "export const readTurns" },
        message: { content: [{ type: "tool_result", content: "export const readTurns" }] },
      }),
      line({ type: "user", isSidechain: true, isMeta: true, message: { content: "the harness wrote this" } }),
    ].join("\n");

    expect(readTurns(delegated, "agent-7f21")).toEqual([
      { speaker: "user", text: "find why the window stays empty", at: Date.parse("2026-11-01T11:00:00.000Z") },
      {
        speaker: "model",
        text: "Every entry of this file is a sidechain.",
        at: Date.parse("2026-11-01T11:00:02.000Z"),
      },
    ]);
    expect(readTurns(delegated, "main")).toEqual([]);
  });

  it("reads the name the harness gave the session, however it was written", () => {
    expect(agentName(line({ type: "agent-name", agentName: "kisuvpalas" }))).toBe("kisuvpalas");
    expect(agentName(line({ type: "custom-title", customTitle: "jogilbunok" }))).toBe("jogilbunok");
    expect(agentName([prompt("hello"), line({ type: "agent-name", agentName: "lobivdigob" })].join("\n"))).toBe(
      "lobivdigob",
    );
    expect(agentName(prompt("a session with no name of its own"))).toBe("");
  });
});

describe("chunking a session", () => {
  const turn = (speaker: "user" | "model", text: string, at: number) => ({ speaker, text, at });
  const chunkTurns = (turns: ReturnType<typeof turn>[]): Chunk[] => {
    const { closed, open } = chunkTurnsCarrying(turns, []);
    return [...closed, ...closeChunks(open)];
  };

  it("keeps each speaker in chunks of its own", () => {
    const chunks = chunkTurns([
      turn("user", "how does the archive resume", 1),
      turn("model", "it asks where the file ends", 2),
      turn("user", "and where is that kept", 3),
    ]);

    expect(chunks.map((chunk) => chunk.speaker)).toEqual(["user", "model"]);
    expect(chunks[0]?.text).toBe("how does the archive resume\n\nand where is that kept");
  });

  // The split the index lives or dies by: a session that ran all day holds a dozen subjects, and a
  // chunk straddling two of them matches neither query well.
  it("closes a chunk where the subject changes rather than where the budget runs out", () => {
    const offsets = "offset".repeat(80);
    const deploys = "deploy".repeat(80);
    const chunks = chunkTurns([
      turn("user", `the archive ${offsets} ends where the offset says`, 1),
      turn("user", `every offset ${offsets} moves before the put`, 2),
      turn("user", `the pipeline ${deploys} runs on merge`, 3),
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain("ends where the offset says");
    expect(chunks[0]?.text).toContain("moves before the put");
    expect(chunks[1]?.text).toContain("runs on merge");
  });

  it("holds a run about one thing together, and cuts a turn longer than a chunk", () => {
    const about = "the offset table keeps where each transcript file ends, beside the session it belongs to. ";
    const together = chunkTurns([turn("user", about.repeat(3), 1), turn("user", about.repeat(2), 2)]);
    expect(together).toHaveLength(1);

    const long = chunkTurns([turn("model", about.repeat(60), 1)]);
    expect(long.length).toBeGreaterThan(1);
    for (const chunk of long) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });
});
