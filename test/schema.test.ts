import { describe, expect, it } from "vitest";
import shared from "../schemas/transcript-entry.json";
import { DASHBOARD_DEVICE, HEAD_BYTES } from "../src/app";
import { GLOBAL_TAG, IDLE_AFTER_MS, MAIN_FILE, parseTranscriptFile, TRANSCRIPT_FILE } from "../src/model";
import { BINARY_RECORD, MAX_RECORDS_BYTES } from "../src/records";
import { readTurns } from "../src/turns";

// What a transcript reader has to know, held in one checked-in file that this service and the CLI
// both read it out of. The plain constants are compared outright; what only the reader knows is
// put to it as an entry built from the file, so a value the reader stopped honouring reads as the
// turn appearing or vanishing rather than as a list that no longer matches.

const AT = "2026-11-02T10:00:00.000Z";

const entry = (fields: Record<string, unknown>, text = "why is the worker test red"): string =>
  JSON.stringify({ type: "user", timestamp: AT, message: { content: text }, ...fields });

const prompts = (line: string, file: string = shared.mainFile): string[] =>
  readTurns(line, file)
    .filter((turn) => turn.speaker === "user")
    .map((turn) => turn.text);

describe("the shared transcript-entry file", () => {
  it("holds the constants the service declares", () => {
    expect(MAIN_FILE).toBe(shared.mainFile);
    expect(BINARY_RECORD).toBe(shared.binaryRecord);
    expect(MAX_RECORDS_BYTES).toBe(shared.maxAppendBytes);
    expect(HEAD_BYTES).toBe(shared.headBytes);
    expect(IDLE_AFTER_MS).toBe(shared.idleAfterMs);
    expect(GLOBAL_TAG).toBe(shared.globalTag);
    expect(DASHBOARD_DEVICE).toBe(shared.dashboardDevice);
  });

  it("names the origin the reader takes a prompt from", () => {
    expect(prompts(entry({ origin: { kind: shared.humanOrigin } }))).toEqual(["why is the worker test red"]);
  });

  it("names every envelope the reader passes over", () => {
    for (const envelope of shared.envelopes) {
      expect(prompts(entry({}, `${envelope}/exit`))).toEqual([]);
    }
  });

  it("names every mark that says a user turn is no prompt", () => {
    for (const mark of shared.promptMarks) {
      expect(prompts(entry({ [mark]: true, origin: { kind: shared.humanOrigin } }))).toEqual([]);
    }
  });

  it("names the mark the reader skips a delegated turn by", () => {
    const delegated = entry({ [shared.sidechainMark]: true, origin: { kind: shared.humanOrigin } });
    expect(prompts(delegated)).toEqual([]);
    expect(prompts(delegated, "agent-1")).toEqual(["why is the worker test red"]);
  });

  it("holds the pattern a transcript file name has to pass", () => {
    const { pattern, maxBytes, extraChars } = shared.transcriptFile;
    const allowed = new RegExp(pattern);
    const names = [
      shared.mainFile,
      "a",
      "A0",
      "agent-1.jsonl",
      "_x",
      ".x",
      "-x",
      "a b",
      "a/b",
      "ä",
      "",
      "a".repeat(maxBytes),
      "a".repeat(maxBytes + 1),
    ];
    for (const name of names) {
      expect(parseTranscriptFile(name).ok, name).toBe(allowed.test(name));
    }
    expect(TRANSCRIPT_FILE.source).toBe(pattern);
    expect(allowed.test("a".repeat(maxBytes))).toBe(true);
    expect(allowed.test("a".repeat(maxBytes + 1))).toBe(false);
    const extra = new Set(extraChars);
    for (const char of "._-!@#+=~ ,/") {
      expect(allowed.test(`a${char}`), char).toBe(extra.has(char));
    }
  });
});
