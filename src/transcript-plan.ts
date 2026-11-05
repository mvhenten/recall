// How a reader walks a transcript backwards. The page carries a manifest — every stretch of the
// chosen file, where it sits and how long it is — and these three steps turn it into one batch of
// ranged reads, the reads gathered back into adjacent text, and the whole lines that text holds.
//
// Two numbers say where the walk has got to: `edge` is the stretch just older than the oldest one
// loaded, and `pending` is how much of that stretch is still unread. A stretch boundary is not a
// line boundary, so the head of each batch is a part line; it is held back as the remnant and
// joined to the batch loaded after it, which holds the rest of that line. A run boundary is a hole
// in the archive, and nothing is joined across one.
//
// A session still being written is followed the other way round: one cursor says how far the file
// has been read to, the stretches past it are read forward, and the part line at the end of a
// batch is the remnant the next batch completes.
//
// Nothing here touches a document or a network, so the whole of the arithmetic a wrong window
// hides in is read and exercised on its own.

// One ranged read of one stretch: which object to open, how much of its head to pass over, and
// how many bytes to take. `skip` is zero for every stretch an archive wrote in order; it is other
// than zero only where a stretch overlaps the one before it, and then it is what keeps the bytes
// they share out of the file twice.
export interface Read {
  offset: number;
  skip: number;
  bytes: number;
}

// One span of a file every byte of which sits in some object. Two stretches that meet exactly are
// one run; a stretch that lands past the end of the one before it opens another, since the bytes
// between them are in no object and the lines either side of the gap do not join up.
export interface Run {
  from: number;
  to: number;
  reads: Read[];
}

// How many ranged reads a page is willing to name. The manifest is written into every view of the
// page, at some forty bytes a read, and a session archived in small stretches holds tens of
// thousands of them; past this the oldest are left off, rather than shipping a megabyte of
// manifest to read a transcript nobody scrolls that far back through.
export const MAX_PLANNED_READS = 500;

export interface Listing {
  runs: Run[];
  /// Where the listing begins, and zero when it names the file from its first byte. A gap in
  /// front of the first run is a hole in the archive only when nothing was left off.
  from: number;
  /// How many of the file's bytes the listing can actually read, which is every byte of its runs
  /// and none of the holes between them. It is what a reader counts up to, so a holed file reads
  /// as finished when it is finished rather than stopping short for ever.
  bytes: number;
}

const readable = (runs: Run[]): number => runs.reduce((all, run) => all + run.to - run.from, 0);

// The newest reads of a file, up to the ceiling, and where the listing begins.
export const listedRuns = (runs: Run[]): Listing => {
  const total = runs.reduce((all, run) => all + run.reads.length, 0);
  if (total <= MAX_PLANNED_READS) return { runs, from: 0, bytes: readable(runs) };
  let drop = total - MAX_PLANNED_READS;
  const kept: Run[] = [];
  for (const run of runs) {
    if (drop >= run.reads.length) {
      drop -= run.reads.length;
      continue;
    }
    const reads = run.reads.slice(drop);
    drop = 0;
    const head = reads[0];
    if (head === undefined) continue;
    kept.push({ from: head.offset + head.skip, to: run.to, reads });
  }
  return { runs: kept, from: kept[0]?.from ?? 0, bytes: readable(kept) };
};

export interface Gaps {
  bytes: number;
  places: number;
}

// The bytes of the listed span that sit in no object at all, and how many runs of them there are.
// The span begins where the listing begins, so a file the archive only caught the end of counts
// the bytes in front of its first stretch, and a listing held back at the ceiling does not count
// what it deliberately left off.
export const gapsIn = (listing: Listing): Gaps => {
  let bytes = 0;
  let places = 0;
  let at = listing.from;
  for (const run of listing.runs) {
    if (run.from > at) {
      bytes += run.from - at;
      places += 1;
    }
    at = run.to;
  }
  return { bytes, places };
};

export interface PlannedRead extends Read {
  /// Which run of the file this read sits in. Nothing is joined across a run boundary.
  run: number;
}

export interface PlannedBatch {
  /// The reads to fetch, oldest first.
  batch: PlannedRead[];
  edge: number;
  pending: number;
}

// The next batch to fetch and where the walk stands once every read of it has landed. The caller's
// own cursor is left alone: a batch that fails part way through leaves the reader exactly where it
// was, and asks for the same bytes again.
export const plannedBatch = (reads: PlannedRead[], edge: number, pending: number, step: number): PlannedBatch => {
  const batch: PlannedRead[] = [];
  let budget = step;
  let at = edge;
  let left = pending;
  while (budget > 0 && left > 0) {
    const read = reads[at - 1];
    if (read === undefined) break;
    const take = Math.min(left, budget);
    batch.unshift({ run: read.run, offset: read.offset, skip: read.skip + left - take, bytes: take });
    budget -= take;
    left -= take;
    if (left === 0) {
      at -= 1;
      left = reads[at - 1]?.bytes ?? 0;
    }
  }
  return { batch, edge: at, pending: left };
};

export interface Fetched extends PlannedRead {
  text: string;
}

export interface Group {
  run: number;
  /// Where in the file this group's text begins.
  at: number;
  text: string;
}

// The batch gathered into one text per run. Two reads of one run are adjacent bytes of the file,
// and two reads either side of a run boundary are not.
export const groupedReads = (fetched: Fetched[]): Group[] => {
  const groups: Group[] = [];
  for (const read of fetched) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.run === read.run) {
      last.text += read.text;
      continue;
    }
    groups.push({ run: read.run, at: read.offset + read.skip, text: read.text });
  }
  return groups;
};

export interface Joined {
  /// The whole lines each group holds, in the order they go into the box.
  texts: string[];
  remnant: string;
}

export interface FollowedBatch {
  /// The reads to fetch, oldest first.
  batch: PlannedRead[];
  /// Where the file has been read to once every read of the batch has landed.
  at: number;
}

// The next batch of a file a session is still writing, reading forward from where the reader has
// got to. Every byte already read is passed over, so nothing on screen is rendered twice, and a
// read is taken whole or not at all, so the cursor lands on a stretch boundary and the listing
// that names the next batch starts there with no part-read stretch behind it.
export const followedBatch = (runs: Run[], from: number, step: number): FollowedBatch => {
  const batch: PlannedRead[] = [];
  let at = from;
  let budget = step;
  for (const [index, run] of runs.entries()) {
    for (const read of run.reads) {
      const ends = read.offset + read.skip + read.bytes;
      if (ends <= at) continue;
      if (budget <= 0) return { batch, at };
      const begins = Math.max(at, read.offset + read.skip);
      batch.push({ run: index, offset: read.offset, skip: begins - read.offset, bytes: ends - begins });
      budget -= ends - begins;
      at = ends;
    }
  }
  return { batch, at };
};

// The groups turned into text that parses, reading forward, newest group last. A batch ends
// wherever the archive has got to and not on a line end, so the last line of a group is a part
// line: it is held back and joined to the group fetched after it. Two groups of one batch sit
// either side of a hole, so nothing is carried from the one to the other.
export const followedTexts = (groups: Group[], remnant: string): Joined => {
  const texts: string[] = [];
  let held = remnant;
  for (const [index, group] of groups.entries()) {
    const text = (index === 0 ? held : "") + group.text;
    const cut = text.lastIndexOf("\n");
    held = cut < 0 ? text : text.slice(cut + 1);
    texts.push(cut < 0 ? "" : text.slice(0, cut + 1));
  }
  return { texts, remnant: held };
};

// How far the walk has got, and how much of it the reader can see. `shown` is what keeps the note
// honest: a walk that read every byte and rendered no turn is the one answer the box must never
// give as success, since an empty box under "the whole of it is here" leaves the reader unable to
// tell an empty transcript from a broken page from the wrong file picked.
export interface Walk {
  file: string;
  /// How many of the file's bytes the listing can read.
  bytes: number;
  /// How many of those have been read so far.
  loaded: number;
  /// How many turns stand in the box.
  shown: number;
  /// Bytes read since the last turn landed, and zero while the walk is still going.
  dry: number;
  /// Whether the walk has reached the start of the listing.
  through: boolean;
  /// Turns that landed at the foot of the box while the reader was reading further up, and zero
  /// while the reader is at the foot and watching them arrive.
  newer: number;
  /// Whether the session the box was following has ended, so nothing more will land.
  ended: boolean;
}

const kb = (bytes: number): string => (bytes < 1_024 ? `${bytes} B` : `${Math.round(bytes / 1_024)} kB`);

// What a box following a session still being written adds to the note. A reader who has scrolled
// back is told what arrived rather than being carried to it, and a session that has ended is said
// to have ended rather than leaving a box that simply stops moving.
const followNote = (walk: Walk): string => {
  if (walk.newer > 0) {
    return ` ${walk.newer} newer ${walk.newer === 1 ? "turn has" : "turns have"} arrived below.`;
  }
  return walk.ended ? " This session has ended, so nothing more will arrive." : "";
};

const readNote = (walk: Walk): string => {
  const whole = `The whole of ${walk.file} is here, ${kb(walk.bytes)} of it`;
  if (walk.through) {
    if (walk.shown > 0) return `${whole}.`;
    return `${whole}, and none of it is prose this reader knows how to show, so the box above is empty.`;
  }
  const read = `${kb(walk.loaded)} of ${kb(walk.bytes)}`;
  if (walk.shown === 0) {
    return `${read} of ${walk.file} read, and none of it is prose this reader knows how to show, so the box above is still empty. Load earlier to keep reading.`;
  }
  if (walk.dry > 0) {
    return `${read} read, and the last ${kb(walk.dry)} of it holds no prose at all. Load earlier to keep reading.`;
  }
  return `${read} read. Scroll up for more.`;
};

// What the box has to say for itself, so what the reader is told and what the reader can see
// cannot disagree.
export const walkNote = (walk: Walk): string => `${readNote(walk)}${followNote(walk)}`;

// The groups turned into text that parses, reading backwards, newest group first. A batch starts
// wherever its budget ran out and not on a line end, so the head of a group is a part line: it is
// held back and joined to the group fetched after it. A group that begins where its run begins has
// nothing in front of it, so nothing is held back there and nothing is carried across the hole
// beyond it.
export const joinedTexts = (groups: Group[], runs: Run[], remnant: string): Joined => {
  const texts: string[] = [];
  let held = remnant;
  for (const group of [...groups].reverse()) {
    const run = runs[group.run];
    let text = group.text + held;
    held = "";
    if (run !== undefined && group.at > run.from) {
      const cut = text.indexOf("\n");
      held = cut < 0 ? text : text.slice(0, cut + 1);
      text = cut < 0 ? "" : text.slice(cut + 1);
    }
    texts.push(text);
  }
  return { texts, remnant: held };
};
