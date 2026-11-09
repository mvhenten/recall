import { describe, expect, it } from "vitest";
import {
  followedRecords,
  gapsInSpans,
  listedSpans,
  MAX_PLANNED_READS,
  plannedRecords,
  type RecordSpan,
  tailNote,
  type Walk,
  walkNote,
} from "../src/transcript-plan";

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

// A file written as so many objects of so many records each. A record is one whole line, so an
// object weighs what its records weigh and the walk counts in both.
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
