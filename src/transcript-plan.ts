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
  /// The whole lines each group holds, newest group first, which is the order they go in at the
  /// top of the box.
  texts: string[];
  remnant: string;
}

// The groups turned into text that parses. A batch starts wherever its budget ran out and not on a
// line end, so the head of a group is a part line: it is held back and joined to the group fetched
// after it. A group that begins where its run begins has nothing in front of it, so nothing is
// held back there and nothing is carried across the hole beyond it.
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
