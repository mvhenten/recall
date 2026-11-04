import { describe, expect, it } from "vitest";
import type { Run } from "../src/transcript-plan";
import {
  type Fetched,
  gapsIn,
  groupedReads,
  joinedTexts,
  listedRuns,
  MAX_PLANNED_READS,
  type PlannedRead,
  plannedBatch,
} from "../src/transcript-plan";

const read = (run: number, offset: number, skip: number, bytes: number): PlannedRead => ({ run, offset, skip, bytes });

const got = (planned: PlannedRead[], texts: string[]): Fetched[] =>
  planned.map((one, index) => ({ ...one, text: texts[index] ?? "" }));

const run = (from: number, to: number): Run => ({ from, to, reads: [] });

// One run written as so many objects of so many bytes each, the way an archive keeping up with a
// running session leaves a file behind.
const written = (from: number, stretches: number, bytes: number): Run => ({
  from,
  to: from + stretches * bytes,
  reads: Array.from({ length: stretches }, (_, index) => ({ offset: from + index * bytes, skip: 0, bytes })),
});

describe("listing a file", () => {
  it("names every read of a file small enough to name, and counts the bytes that can be read", () => {
    const runs = [written(0, 3, 10), written(100, 2, 10)];

    expect(listedRuns(runs)).toEqual({ runs, from: 0, bytes: 50 });
    expect(gapsIn(listedRuns(runs))).toEqual({ bytes: 70, places: 1 });
  });

  // A file the archive only caught the end of has a hole in front of everything it holds, and
  // counting from its first run would report a whole file with no gap in it.
  it("counts the bytes in front of the first stretch as the hole they are", () => {
    expect(gapsIn(listedRuns([written(9_000, 1, 40)]))).toEqual({ bytes: 9_000, places: 1 });
  });

  // The manifest rides in every view of the page, so a session archived in tens of thousands of
  // small stretches names the newest of them and leaves the rest off.
  it("leaves the oldest reads off a file past the ceiling, and says where it starts instead", () => {
    const listing = listedRuns([written(0, 20, 10), written(500, MAX_PLANNED_READS, 10)]);

    expect(listing.runs).toHaveLength(1);
    expect(listing.runs.reduce((all, one) => all + one.reads.length, 0)).toBe(MAX_PLANNED_READS);
    expect(listing).toMatchObject({ from: 500, bytes: MAX_PLANNED_READS * 10 });
    // What it left off is not a hole in the archive, and is not reported as one.
    expect(gapsIn(listing)).toEqual({ bytes: 0, places: 0 });
  });

  it("keeps the part of a run it can name, starting that run where its first named read starts", () => {
    const listing = listedRuns([written(0, MAX_PLANNED_READS + 20, 10)]);

    expect(listing.runs).toHaveLength(1);
    expect(listing.runs[0]).toMatchObject({ from: 200, to: (MAX_PLANNED_READS + 20) * 10 });
    expect(listing).toMatchObject({ from: 200, bytes: MAX_PLANNED_READS * 10 });
  });
});

describe("planning a batch", () => {
  it("walks backwards one stretch at a time, taking the tail of the oldest stretch loaded", () => {
    const reads = [read(0, 0, 0, 100), read(0, 100, 0, 100)];

    const first = plannedBatch(reads, 2, 100, 40);
    expect(first.batch).toEqual([read(0, 100, 60, 40)]);
    expect(first).toMatchObject({ edge: 2, pending: 60 });

    const second = plannedBatch(reads, first.edge, first.pending, 80);
    expect(second.batch).toEqual([read(0, 0, 80, 20), read(0, 100, 0, 60)]);
    expect(second).toMatchObject({ edge: 1, pending: 80 });
  });

  // The whole of finding 1: a batch that fails part way through must leave the walk exactly where
  // it was, or the next click resumes past bytes nobody ever read.
  it("moves nothing the caller holds, so a batch that is never fetched costs nothing", () => {
    const reads = [read(0, 0, 0, 100), read(0, 100, 0, 100)];
    const edge = 2;
    const pending = 100;

    plannedBatch(reads, edge, pending, 150);
    const again = plannedBatch(reads, edge, pending, 150);

    expect(again.batch).toEqual([read(0, 0, 50, 50), read(0, 100, 0, 100)]);
    expect(reads).toEqual([read(0, 0, 0, 100), read(0, 100, 0, 100)]);
  });

  it("carries the skip of an overlapping stretch, so bytes two stretches share are read once", () => {
    const reads = [read(0, 0, 0, 100), read(0, 80, 20, 60)];

    const planned = plannedBatch(reads, 2, 60, 1_000);

    expect(planned.batch).toEqual([read(0, 0, 0, 100), read(0, 80, 20, 60)]);
    expect(planned).toMatchObject({ edge: 0, pending: 0 });
  });

  it("stops at the first byte of the file and plans nothing beyond it", () => {
    const reads = [read(0, 0, 0, 10)];

    const whole = plannedBatch(reads, 1, 10, 1_000);
    expect(whole.batch).toEqual([read(0, 0, 0, 10)]);
    expect(whole).toMatchObject({ edge: 0, pending: 0 });
    expect(plannedBatch(reads, 0, 0, 1_000)).toEqual({ batch: [], edge: 0, pending: 0 });
  });
});

describe("joining what came back", () => {
  it("holds back the part line a batch starts on and joins it to the batch fetched next", () => {
    const runs = [run(0, 20)];
    const tail = plannedBatch([read(0, 0, 0, 20)], 1, 20, 9);

    const first = joinedTexts(groupedReads(got(tail.batch, ['d"}\n{"b":2}\n'])), runs, "");
    expect(first.texts).toEqual(['{"b":2}\n']);
    expect(first.remnant).toBe('d"}\n');

    const head = plannedBatch([read(0, 0, 0, 20)], tail.edge, tail.pending, 11);
    const second = joinedTexts(groupedReads(got(head.batch, ['{"a":"goo'])), runs, first.remnant);
    expect(second.texts).toEqual(['{"a":"good"}\n']);
    expect(second.remnant).toBe("");
  });

  it("holds nothing back at the head of a run, so the first entry of the file is read", () => {
    const joined = joinedTexts([{ run: 0, at: 0, text: '{"a":1}\n{"b":2}\n' }], [run(0, 16)], "");

    expect(joined.texts).toEqual(['{"a":1}\n{"b":2}\n']);
    expect(joined.remnant).toBe("");
  });

  // A run begins where the archive picked the file up again, which is the middle of whatever entry
  // the hole swallowed. That torn line is left to fail to parse, and nothing of it is carried back
  // over the hole onto the run before it.
  it("joins nothing across a hole", () => {
    const runs = [run(0, 8), run(100, 111)];
    const fetched = got([read(0, 0, 0, 8), read(1, 100, 0, 11)], ['{"a":1}\n', '2}\n{"c":3}\n']);

    const joined = joinedTexts(groupedReads(fetched), runs, "");

    expect(joined.texts).toEqual(['2}\n{"c":3}\n', '{"a":1}\n']);
    expect(joined.remnant).toBe("");
  });

  it("keeps holding an entry longer than one batch until the batch that completes it lands", () => {
    const runs = [run(0, 30)];

    const first = joinedTexts([{ run: 0, at: 20, text: "ddle}\nend\n" }], runs, "");
    expect(first.texts).toEqual(["end\n"]);
    const second = joinedTexts([{ run: 0, at: 10, text: "{start:mi" }], runs, first.remnant);
    expect(second.texts).toEqual([""]);
    expect(second.remnant).toBe("{start:middle}\n");
    const third = joinedTexts([{ run: 0, at: 0, text: "head\n" }], runs, second.remnant);
    expect(third.texts).toEqual(["head\n{start:middle}\n"]);
    expect(third.remnant).toBe("");
  });

  it("gathers the reads of one run into one text and leaves two runs apart", () => {
    const fetched = got([read(0, 0, 0, 2), read(0, 2, 0, 2), read(1, 50, 0, 2)], ["ab", "cd", "ef"]);

    expect(groupedReads(fetched)).toEqual([
      { run: 0, at: 0, text: "abcd" },
      { run: 1, at: 50, text: "ef" },
    ]);
  });
});
