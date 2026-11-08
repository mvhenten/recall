import { describe, expect, it } from "vitest";
import type { Run } from "../src/transcript-plan";
import {
  compressedStretchName,
  type Fetched,
  followedBatch,
  followedRecords,
  followedTexts,
  gapsIn,
  gapsInSpans,
  groupedReads,
  joinedTexts,
  legacyStretchName,
  listedRuns,
  listedSpans,
  MAX_PLANNED_READS,
  type PlannedRead,
  plannedBatch,
  plannedRecords,
  type RecordSpan,
  tailNote,
  type Walk,
  walkNote,
} from "../src/transcript-plan";

const read = (run: number, offset: number, skip: number, bytes: number): PlannedRead => ({
  run,
  at: legacyStretchName(offset),
  offset,
  skip,
  bytes,
});

const got = (planned: PlannedRead[], texts: string[]): Fetched[] =>
  planned.map((one, index) => ({ ...one, text: texts[index] ?? "" }));

const run = (from: number, to: number): Run => ({ from, to, reads: [] });

// One run written as so many objects of so many bytes each, the way an archive keeping up with a
// running session leaves a file behind.
const written = (from: number, stretches: number, bytes: number): Run => ({
  from,
  to: from + stretches * bytes,
  reads: Array.from({ length: stretches }, (_, index) => ({
    at: legacyStretchName(from + index * bytes),
    offset: from + index * bytes,
    skip: 0,
    bytes,
  })),
});

describe("listing a file", () => {
  it("names every read of a file small enough to name, and counts the bytes that can be read", () => {
    const runs = [written(0, 3, 10), written(100, 2, 10)];

    expect(listedRuns(runs)).toEqual({ runs, from: 0, readable: 50 });
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
    expect(listing).toMatchObject({ from: 500, readable: MAX_PLANNED_READS * 10 });
    // What it left off is not a hole in the archive, and is not reported as one.
    expect(gapsIn(listing)).toEqual({ bytes: 0, places: 0 });
  });

  it("keeps the part of a run it can name, starting that run where its first named read starts", () => {
    const listing = listedRuns([written(0, MAX_PLANNED_READS + 20, 10)]);

    expect(listing.runs).toHaveLength(1);
    expect(listing.runs[0]).toMatchObject({ from: 200, to: (MAX_PLANNED_READS + 20) * 10 });
    expect(listing).toMatchObject({ from: 200, readable: MAX_PLANNED_READS * 10 });
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

  // A stretch stored gzipped is one gzip member, which has no part to ask for: the whole object
  // comes down and the browser inflates it. Splitting a read of one would fetch and inflate the
  // same object once per piece, so the budget is spent past rather than inside it.
  it("takes a compressed stretch whole, however little budget is left", () => {
    const packed = (at: number, bytes: number): PlannedRead => ({
      run: 0,
      at: compressedStretchName(at, at + bytes * 3, bytes),
      offset: at,
      skip: 0,
      bytes,
    });
    const reads = [packed(0, 100), packed(100, 100)];

    const first = plannedBatch(reads, 2, 100, 40);
    expect(first.batch).toEqual([packed(100, 100)]);
    expect(first).toMatchObject({ edge: 1, pending: 100 });

    const second = plannedBatch(reads, first.edge, first.pending, 40);
    expect(second.batch).toEqual([packed(0, 100)]);
    expect(second).toMatchObject({ edge: 0, pending: 0 });
  });

  it("stops at the first byte of the file and plans nothing beyond it", () => {
    const reads = [read(0, 0, 0, 10)];

    const whole = plannedBatch(reads, 1, 10, 1_000);
    expect(whole.batch).toEqual([read(0, 0, 0, 10)]);
    expect(whole).toMatchObject({ edge: 0, pending: 0 });
    expect(plannedBatch(reads, 0, 0, 1_000)).toEqual({ batch: [], edge: 0, pending: 0 });
  });
});

describe("saying how the walk went", () => {
  const walk = (over: Partial<Walk>): Walk => ({
    file: "agent-7f21",
    bytes: 75_776,
    loaded: 75_776,
    shown: 4,
    dry: 0,
    through: true,
    ...over,
  });

  it("says the file was read whole, and what was in it, when something rendered", () => {
    expect(walkNote(walk({}))).toBe("The whole of agent-7f21 is here, 74 kB of it.");
  });

  // The bug this is here for: a file read end to end that rendered no turn was reported as the
  // whole file being there, under a box with nothing in it.
  it("never reports a walk that rendered nothing as the whole file being here", () => {
    const note = walkNote(walk({ shown: 0 }));

    expect(note).toContain("agent-7f21");
    expect(note).toContain("74 kB");
    expect(note).toContain("none of it is prose this reader knows how to show");
    expect(note).toContain("the box above is empty");
  });

  it("says the same of a walk still short of the start of the file", () => {
    const note = walkNote(walk({ loaded: 20_480, shown: 0, dry: 20_480, through: false }));

    expect(note).toBe(
      "20 kB of 74 kB of agent-7f21 read, and none of it is prose this reader knows how to show, so the box above is still empty. Load earlier to keep reading.",
    );
  });

  it("names the dry stretch only once something is on screen to read", () => {
    expect(walkNote(walk({ loaded: 40_960, dry: 20_480, through: false }))).toBe(
      "40 kB of 74 kB read, and the last 20 kB of it holds no prose at all. Load earlier to keep reading.",
    );
    expect(walkNote(walk({ loaded: 40_960, through: false }))).toBe("40 kB of 74 kB read. Scroll up for more.");
  });
});

describe("saying what following has to say", () => {
  // A reader who has scrolled back is not carried to the foot of the box, so the line is the only
  // thing that can tell them the session has said something since; a session that has ended says
  // so, rather than leaving a box that simply stops moving; and a reader at the foot watching
  // turns arrive is told nothing at all.
  it("counts what landed below a reader, and gives way to the end of the session", () => {
    expect(tailNote({ newer: 1, ended: false })).toBe("1 newer turn has arrived below.");
    expect(tailNote({ newer: 2, ended: true })).toBe("2 newer turns have arrived below.");
    expect(tailNote({ newer: 0, ended: true })).toBe("This session has ended, so nothing more will arrive.");
    expect(tailNote({ newer: 0, ended: false })).toBe("");
  });
});

describe("following a file still being written", () => {
  it("reads forward over the stretches past the cursor and never over one already read", () => {
    const runs = [written(0, 3, 100)];

    const first = followedBatch(runs, 200, 1_000);
    expect(first.batch).toEqual([read(0, 200, 0, 100)]);
    expect(first.at).toBe(300);
    expect(followedBatch(runs, first.at, 1_000)).toEqual({ batch: [], at: 300 });
  });

  // A beat behind a hidden tab comes back to more than one step's worth. Taking reads whole keeps
  // the cursor on a stretch boundary, so the next beat asks for stretches and not for part of one.
  it("stops at the step, taking every read whole, and takes the rest on the next beat", () => {
    const runs = [written(0, 5, 100)];

    const first = followedBatch(runs, 0, 250);
    expect(first.batch).toEqual([read(0, 0, 0, 100), read(0, 100, 0, 100), read(0, 200, 0, 100)]);
    expect(first.at).toBe(300);

    const second = followedBatch(runs, first.at, 250);
    expect(second.batch).toEqual([read(0, 300, 0, 100), read(0, 400, 0, 100)]);
    expect(second.at).toBe(500);
  });

  it("takes only the unread tail of a stretch the cursor sits inside", () => {
    const runs: Run[] = [{ from: 0, to: 140, reads: [{ at: legacyStretchName(0), offset: 0, skip: 0, bytes: 140 }] }];

    expect(followedBatch(runs, 100, 1_000)).toEqual({ batch: [read(0, 0, 100, 40)], at: 140 });
  });

  it("steps over a hole and names the run each read sits in", () => {
    const runs = [written(0, 1, 50), written(900, 1, 50)];

    expect(followedBatch(runs, 50, 1_000)).toEqual({ batch: [read(1, 900, 0, 50)], at: 950 });
  });

  it("holds back the part line a beat ends on and joins it to the beat that completes it", () => {
    const first = followedTexts([{ run: 0, at: 0, text: '{"a":1}\n{"b":' }], "");
    expect(first.texts).toEqual(['{"a":1}\n']);
    expect(first.remnant).toBe('{"b":');

    const second = followedTexts([{ run: 0, at: 13, text: "2}\n" }], first.remnant);
    expect(second.texts).toEqual(['{"b":2}\n']);
    expect(second.remnant).toBe("");
  });

  it("keeps holding an entry longer than one beat until the beat that completes it lands", () => {
    const first = followedTexts([{ run: 0, at: 0, text: "{start:" }], "");
    expect(first.texts).toEqual([""]);
    const second = followedTexts([{ run: 0, at: 7, text: "middle" }], first.remnant);
    expect(second.texts).toEqual([""]);
    expect(second.remnant).toBe("{start:middle");
    const third = followedTexts([{ run: 0, at: 13, text: "}\n" }], second.remnant);
    expect(third.texts).toEqual(["{start:middle}\n"]);
    expect(third.remnant).toBe("");
  });

  // The torn line either side of a hole is left to fail to parse rather than glued into an entry
  // the session never wrote.
  it("carries nothing across a hole inside one beat", () => {
    const joined = followedTexts(
      [
        { run: 0, at: 0, text: '{"a":1}\n{"b"' },
        { run: 1, at: 900, text: ':2}\n{"c":3}\n' },
      ],
      "",
    );

    expect(joined.texts).toEqual(['{"a":1}\n', ':2}\n{"c":3}\n']);
    expect(joined.remnant).toBe("");
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

// A file the record path holds, written as so many objects of so many records each. A record is
// one whole line, so an object weighs what its records weigh and the walk counts in both.
const spans = (sizes: number[], bytes: number): RecordSpan[] => {
  const written: RecordSpan[] = [];
  let from = 0;
  for (const held of sizes) {
    written.push({ from, held, bytes: held * bytes });
    from += held;
  }
  return written;
};

describe("planning a window of records", () => {
  it("takes whole objects walking backwards, and opens where the one it stopped at opens", () => {
    const written = spans([4, 4, 4], 10);

    const first = plannedRecords(written, 12, 100);
    expect(first).toEqual({ from: 0, through: 12, bytes: 120 });

    const held = plannedRecords(written, 12, 50);
    expect(held).toEqual({ from: 4, through: 12, bytes: 80 });
    expect(plannedRecords(written, held.from, 50)).toEqual({ from: 0, through: 4, bytes: 40 });
  });

  // A walk that could not take an object weighing more than a step would never reach the start of
  // a file one big append wrote, and the box would stop on a window it refetched for ever.
  it("takes one object however little budget is left", () => {
    expect(plannedRecords(spans([3], 1_000), 3, 10)).toEqual({ from: 0, through: 3, bytes: 3_000 });
  });

  // A window the objects do not tile is a read no archive can answer, so neither direction asks
  // for one. Stopping at the hole instead would put every record on the far side of it out of
  // reach, with the box saying it had read the file to the end; a beat that stopped would bring
  // nothing back for as long as the session ran.
  it("steps over a hole rather than stopping in front of it", () => {
    const held = [
      { from: 0, held: 2, bytes: 20 },
      { from: 5, held: 2, bytes: 20 },
    ];

    expect(plannedRecords(held, 7, 1_000)).toEqual({ from: 5, through: 7, bytes: 20 });
    expect(plannedRecords(held, 5, 1_000)).toEqual({ from: 0, through: 2, bytes: 20 });
    expect(plannedRecords(held, 0, 1_000)).toEqual({ from: 0, through: 0, bytes: 0 });

    expect(followedRecords(held, 2, 1_000)).toEqual({ from: 5, through: 7, bytes: 20 });
    expect(followedRecords(held, 7, 1_000)).toEqual({ from: 7, through: 7, bytes: 0 });
  });

  it("counts the records of a listing that sit in no object, and where they are missing from", () => {
    const listed = listedSpans([
      { from: 0, held: 2, bytes: 20 },
      { from: 5, held: 2, bytes: 20 },
      { from: 9, held: 1, bytes: 10 },
    ]);

    expect(gapsInSpans(listed)).toEqual({ records: 5, places: 2 });
    expect(gapsInSpans(listedSpans(spans([4, 4], 10)))).toEqual({ records: 0, places: 0 });
  });

  // A listing the ceiling did not hold back names the file from its first record, so an object
  // opening past zero has a hole in front of it and not a manifest stopping short. Reading it the
  // other way tells the reader the page held records back when the archive never had them.
  it("counts a hole at the start of a file the ceiling did not hold back", () => {
    const late = listedSpans([{ from: 3, held: 2, bytes: 20 }]);

    expect(late.from).toBe(0);
    expect(gapsInSpans(late)).toEqual({ records: 3, places: 1 });

    const trimmed = listedSpans(
      Array.from({ length: MAX_PLANNED_READS + 1 }, (_, at) => ({
        from: at * 2,
        held: 2,
        bytes: 20,
      })),
    );
    expect(trimmed.from).toBe(2);
    expect(gapsInSpans(trimmed)).toEqual({ records: 0, places: 0 });
  });

  it("reads forward from where the box has got to, and passes over the records it has", () => {
    const written = spans([4, 4, 4, 4], 10);

    expect(followedRecords(written, 4, 1_000)).toEqual({ from: 4, through: 16, bytes: 120 });
    const held = followedRecords(written, 4, 50);
    expect(held).toEqual({ from: 4, through: 12, bytes: 80 });
    expect(followedRecords(written, held.through, 50)).toEqual({ from: 12, through: 16, bytes: 40 });
  });

  it("reads nothing forward where nothing has landed since the box last looked", () => {
    expect(followedRecords(spans([4], 10), 4, 1_000)).toEqual({ from: 4, through: 4, bytes: 0 });
  });

  it("names the newest spans of a file too long to name whole, and says where it opens", () => {
    const written = spans(
      Array.from({ length: MAX_PLANNED_READS + 3 }, () => 2),
      10,
    );
    const listed = listedSpans(written);

    expect(listed.spans).toHaveLength(MAX_PLANNED_READS);
    expect(listed.from).toBe(6);
    expect(listed.readable).toBe(MAX_PLANNED_READS * 2);
    expect(listed.bytes).toBe(MAX_PLANNED_READS * 20);
  });
});
