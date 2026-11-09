// How a reader walks a transcript backwards. The page carries a manifest — every object of the
// chosen file, the ordinal it opens at and how many records it holds — and these steps turn it
// into the window to fetch next and what that window weighs.
//
// One number says where the walk has got to: `edge` is the ordinal just older than the oldest
// record loaded. A record is one whole line verbatim, so a window of them parses on its own —
// there is no range to ask for, no part line to carry between windows and nothing to join. A hole
// is a run of ordinals no object holds, and the walk opens on the far side of one rather than
// stopping at it.
//
// A session still being written is followed the other way round: one cursor says how many records
// of the file have been read, and the objects past it are read forward.
//
// Nothing here touches a document or a network, so the whole of the arithmetic a wrong window
// hides in is read and exercised on its own.

// How many objects a page is willing to name. The manifest is written into every view of the
// page, and a session appending a record at a time holds one object per record; past this the
// oldest are left off, rather than shipping a megabyte of manifest to read a transcript nobody
// scrolls that far back through.
export const MAX_PLANNED_READS = 500;

// Where the box starts following a file still being written, and how often it beats. `from` is
// the end of the manifest the page was handed, counted in ordinals: a record is a line of the
// file, which redaction cannot move, so an ordinal is a count and a place at once.
export interface Follow {
  from: number;
  every: number;
}

// One object of a file, as the window of the file it answers for: the ordinal its first record
// carries, how many it holds, and what those weigh in the transcript they join back to, counting
// the break that closes the last of them.
//
// A record is addressed by its ordinal and an object is the unit the archive hands back, so these
// are what a window of the file is planned against: every window opens and ends on an object
// boundary, and nothing asks for a byte of one.
export interface RecordSpan {
  from: number;
  held: number;
  bytes: number;
}

// What the page hands the browser: the route a window of the file is read off, the manifest the
// walk is planned against, and where to pick a file still being written up from.
export interface Plan {
  path: string;
  file: string;
  step: number;
  follow: Follow | null;
  /// What the listed records weigh, which is a length of the archive and no place in the file.
  bytes: number;
  spans: RecordSpan[];
}

// What a beat is answered with: whether anyone is still running the session, and the objects
// holding records the reader has not read, which is what the window it asks for next is planned
// against.
export interface RecordReach {
  running: boolean;
  spans: RecordSpan[];
}

export interface SpanListing {
  spans: RecordSpan[];
  /// Where the listing begins, and zero when it names the file from its first record. A listing
  /// the ceiling did not hold back names the whole file however late its first object opens, so
  /// what sits in front of that object is a hole in the archive and not a manifest stopping short.
  from: number;
  /// How many records it can read, and what they weigh.
  readable: number;
  bytes: number;
}

// The newest spans of a file, up to the ceiling. A session appending a record at a time holds one
// object per record, and a page carrying every one of them would ship a manifest nobody scrolls
// far enough back to spend.
export const listedSpans = (spans: RecordSpan[]): SpanListing => {
  const held = spans.length > MAX_PLANNED_READS;
  const kept = held ? spans.slice(spans.length - MAX_PLANNED_READS) : spans;
  return {
    spans: kept,
    from: held ? (kept[0]?.from ?? 0) : 0,
    readable: kept.reduce((all, span) => all + span.held, 0),
    bytes: kept.reduce((all, span) => all + span.bytes, 0),
  };
};

// One window of a file: the ordinal it opens at, the one past its last record, and what the
// records in it weigh. A window never spans a hole — the objects covering one have to
// tile it exactly for the archive to answer it at all — so both ends sit in the same run of
// records, and a walk that has a hole in front of it steps over it and opens the far side.
export interface RecordWindow {
  from: number;
  through: number;
  bytes: number;
}

const nothingAt = (place: number): RecordWindow => ({ from: place, through: place, bytes: 0 });

// The next window to fetch walking backwards, and the whole of what the walk needs to know once it
// has landed: the walk carries on from `from`. Whole objects are taken until the budget is spent,
// and at least one always is, so a walk cannot stall on an object weighing more than a step.
//
// Where the span below the cursor does not reach it, the records between the two are in no object
// and the window opens on the far side of them rather than asking for a span the archive cannot
// tile. Stopping at the hole instead would leave every record in front of it unreachable, with the
// box saying it had read the file to the end.
export const plannedRecords = (spans: readonly RecordSpan[], edge: number, step: number): RecordWindow => {
  let at = spans.length - 1;
  while (at >= 0 && (spans[at]?.from ?? edge) >= edge) at -= 1;
  const span = spans[at];
  if (span === undefined) return nothingAt(edge);
  const through = span.from + span.held;
  let from = through;
  let bytes = 0;
  for (; at >= 0; at -= 1) {
    const one = spans[at];
    if (one === undefined) continue;
    if (one.from + one.held !== from) break;
    if (bytes >= step) break;
    from = one.from;
    bytes += one.bytes;
  }
  return { from, through, bytes };
};

// The next window of a file a session is still writing, reading forward from where the reader has
// got to. Every record already read is passed over, so nothing on screen is rendered twice, and
// the window ends on an object boundary, so the next beat opens exactly where this one stopped.
//
// A hole in front of the cursor is stepped over the same way: the window opens at the first object
// holding a record the reader has not read. A beat that stopped at the hole would read nothing for
// as long as the session ran, and a box beating on in silence is one a reader reads as stopped.
export const followedRecords = (spans: readonly RecordSpan[], at: number, step: number): RecordWindow => {
  const opens = spans.find((span) => span.from + span.held > at);
  if (opens === undefined) return nothingAt(at);
  const from = Math.max(at, opens.from);
  let through = from;
  let bytes = 0;
  for (const span of spans) {
    if (span.from + span.held <= through) continue;
    if (span.from !== through) break;
    if (bytes >= step) break;
    through = span.from + span.held;
    bytes += span.bytes;
  }
  return { from, through, bytes };
};

export interface SpanGaps {
  records: number;
  places: number;
}

// The records of the listed span that sit in no object at all, and how many runs of them there
// are. The span begins where the listing begins, so a listing held back at the ceiling does not
// count what it deliberately left off.
export const gapsInSpans = (listing: SpanListing): SpanGaps => {
  let records = 0;
  let places = 0;
  let at = listing.from;
  for (const span of listing.spans) {
    if (span.from > at) {
      records += span.from - at;
      places += 1;
    }
    at = span.from + span.held;
  }
  return { records, places };
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
}

// What a box following a session still being written has to say for itself. It is a line of its
// own under the box and never part of the walk's: the two read different objects and fail apart
// from each other, so a tail nobody can read says nothing about how far back the reader can walk,
// and a walk that has given up must not take the live news down with it.
export interface Tail {
  /// Turns that landed at the foot of the box while the reader was reading further up, and zero
  /// while the reader is at the foot and watching them arrive.
  newer: number;
  /// Whether the session the box was following has ended, so nothing more will land.
  ended: boolean;
}

const kb = (bytes: number): string => (bytes < 1_024 ? `${bytes} B` : `${Math.round(bytes / 1_024)} kB`);

// A reader who has scrolled back is told what arrived rather than being carried to it, and a
// session that has ended is said to have ended rather than leaving a box that simply stops moving.
export const tailNote = (tail: Tail): string => {
  if (tail.newer > 0) {
    return `${tail.newer} newer ${tail.newer === 1 ? "turn has" : "turns have"} arrived below.`;
  }
  return tail.ended ? "This session has ended, so nothing more will arrive." : "";
};

// What the walk has to say for itself, so what the reader is told and what the reader can see
// cannot disagree.
export const walkNote = (walk: Walk): string => {
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
