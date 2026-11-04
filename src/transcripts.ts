// R2 has no append, so a session's transcript is kept as one object per appended stretch, under
// `<user id>/<session id>/<file>/<start offset>`. The offset is zero-padded, so listing the prefix
// gives the stretches in the order they were written and reading one file is a concatenation. A
// stretch is keyed by where it starts and nothing else, so a caller that retries one writes the
// same key again instead of a second copy of the same lines.
//
// The object is the only write an append makes, and the key says everything about it: who, which
// session, which file and where in it. Everything else the service holds about a transcript is
// derived from that key by the consumer the storage event wakes, and nothing derived is ever
// asked a question the objects can answer, so a row that disagrees with them is wrong by
// definition and is written over by the listing that found it out.
const OFFSET_DIGITS = 16;

// The largest stretch one call may carry. A transcript of any size lands as a run of these.
export const MAX_CHUNK_BYTES = 1_048_576;

// The name a session's own transcript is held under; mirrors MAIN in cli/src/transcripts.rs. Every
// other name is a delegated turn, which the index never reads.
export const MAIN_FILE = "main";

export interface TranscriptFile {
  file: string;
  bytes: number;
}

// One stretch, read back off the key that names it. `end` is where the file reaches once this
// object is in it, which is the whole of what the key and the object's size say.
export interface Chunk {
  userId: string;
  sessionId: string;
  file: string;
  offset: number;
  end: number;
}

const chunkKey = (userId: string, sessionId: string, file: string, offset: number): string =>
  `${userId}/${sessionId}/${file}/${String(offset).padStart(OFFSET_DIGITS, "0")}`;

const filePrefix = (userId: string, sessionId: string, file: string): string => `${userId}/${sessionId}/${file}/`;

const sessionPrefix = (userId: string, sessionId: string): string => `${userId}/${sessionId}/`;

const OFFSET_SEGMENT = new RegExp(`^[0-9]{${OFFSET_DIGITS}}$`);

// The stretch one key names, read off whatever named it: an object a listing caught, or the key
// and size a storage event carries. A key the archive did not write, and an event for anything
// but a write, is no stretch and is passed over rather than guessed at.
export const parseChunkKey = (key: string, size: number): Chunk | null => {
  const [userId, sessionId, file, offset, ...rest] = key.split("/");
  if (userId === undefined || sessionId === undefined || file === undefined || offset === undefined) return null;
  if (rest.length > 0 || userId === "" || sessionId === "" || file === "") return null;
  if (!OFFSET_SEGMENT.test(offset) || !Number.isSafeInteger(size) || size < 0) return null;
  const from = Number(offset);
  return { userId, sessionId, file, offset: from, end: from + size };
};

interface Stretch {
  key: string;
  from: number;
  bytes: number;
}

// The stretches one file was written as, in the order they were written. A stretch is keyed by
// where it starts, so the key names its place and the listing comes back sorted by it.
const stretches = async (bucket: R2Bucket, userId: string, sessionId: string, file: string): Promise<Stretch[]> => {
  const prefix = filePrefix(userId, sessionId, file);
  const found: Stretch[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) {
      found.push({ key: object.key, from: Number(object.key.slice(prefix.length)), bytes: object.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return found.sort((left, right) => left.from - right.from);
};

// One file's stretches and how far it runs, listed once. A reader that walks a file reads several
// windows out of the same listing, and listing the prefix again per window is what made a page
// view cost a listing per click.
export interface Archive {
  parts: Stretch[];
  bytes: number;
}

export const archiveOf = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<Archive> => {
  const parts = await stretches(bucket, userId, sessionId, file);
  return { parts, bytes: parts.reduce((end, part) => Math.max(end, part.from + part.bytes), 0) };
};

// One of a session's transcript files, read back whole as the concatenation of its stretches. The
// body is streamed rather than gathered: a long session's transcript runs to megabytes, and a
// reader restoring one writes it out as it arrives.
export const readTranscript = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<ReadableStream<Uint8Array> | null> => {
  const parts = await stretches(bucket, userId, sessionId, file);
  if (parts.length === 0) return null;
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = parts[next];
      if (part === undefined) {
        controller.close();
        return;
      }
      next += 1;
      const object = await bucket.get(part.key);
      if (object === null) throw new Error(`the archive lost ${part.key}`);
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
};

export interface Bite {
  text: string;
  /// Where in the file this bite begins and ends, as positions in the file and never counts of
  /// bytes read. The two part company over a hole, and a mark that could mean either would have a
  /// reader index prose it already held or skip prose it never did.
  from: number;
  through: number;
}

// A run of bytes read out of one stretch, carrying the file position it starts at. Two pieces are
// adjacent in the buffer and apart in the file whenever the read stepped over a hole, so a cut is
// only ever made by holding both numbers.
interface Piece {
  at: number;
  body: Uint8Array;
}

interface Gathered {
  pieces: Piece[];
  at: number;
  /// Nothing further to read before `to`: either the read reached it, or the stretches ran out.
  level: boolean;
}

// A hole is a run of bytes no object covers, which is what a stretch sent past the end of the
// file leaves behind. Those bytes exist nowhere, so the read steps over the hole to the next
// stretch rather than reading across it as though the file ran on.
const gather = async (
  bucket: R2Bucket,
  parts: Stretch[],
  from: number,
  to: number,
  limit: number,
): Promise<Gathered> => {
  const pieces: Piece[] = [];
  let at = from;
  let held = 0;
  for (;;) {
    if (at >= to) return { pieces, at, level: true };
    if (held >= limit) return { pieces, at, level: false };
    const covering = parts.find((part) => part.from <= at && part.from + part.bytes > at);
    const part = covering ?? parts.find((part) => part.from > at);
    if (part === undefined) return { pieces, at, level: true };
    at = Math.max(at, part.from);
    const offset = at - part.from;
    const length = Math.min(part.bytes - offset, limit - held, to - at);
    const object = await bucket.get(part.key, { range: { offset, length } });
    if (object === null) throw new Error(`the archive lost ${part.key}`);
    const body = new Uint8Array(await object.arrayBuffer());
    pieces.push({ at, body });
    held += body.byteLength;
    at += body.byteLength;
  }
};

const extent = (pieces: Piece[]): number => pieces.reduce((all, piece) => all + piece.body.byteLength, 0);

const decode = (pieces: Piece[], start: number, end: number): string => {
  const bytes = new Uint8Array(extent(pieces));
  let written = 0;
  for (const piece of pieces) {
    bytes.set(piece.body, written);
    written += piece.body.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(start, end));
};

// Where a line ends, as both the file position just past the newline and the index just past it in
// the gathered buffer. The two are the same only when the read crossed no hole.
interface Cut {
  at: number;
  index: number;
}

const lastCut = (pieces: Piece[]): Cut | null => {
  let before = extent(pieces);
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (piece === undefined) continue;
    before -= piece.body.byteLength;
    const found = piece.body.lastIndexOf(10);
    if (found < 0) continue;
    return { at: piece.at + found + 1, index: before + found + 1 };
  }
  return null;
};

// The first line end inside the gathered bytes, ignoring one that falls on the very last byte: a
// window read backwards ends on a line already, and cutting its head there would leave it empty.
const firstCut = (pieces: Piece[]): Cut | null => {
  let before = 0;
  const stop = extent(pieces) - 1;
  for (const piece of pieces) {
    const found = piece.body.indexOf(10);
    if (found >= 0 && before + found < stop) return { at: piece.at + found + 1, index: before + found + 1 };
    before += piece.body.byteLength;
  }
  return null;
};

// One bite of a file, from `from` and at most `limit` bytes, for a reader that will come back for
// the rest. Both ends fall on an entry boundary, so the next bite read from `through` holds the
// entry this one stopped before and never half of it.
//
// An entry longer than the window is read whole rather than cut: a window of raw mid-entry bytes
// parses as nothing and would render as an empty stretch, which is the one thing a reader cannot
// tell from a session that said nothing.
export const readFrom = async (
  bucket: R2Bucket,
  archive: Archive,
  from: number,
  to: number,
  limit: number,
): Promise<Bite> => {
  const pieces: Piece[] = [];
  let at = from;
  for (;;) {
    const got = await gather(bucket, archive.parts, at, to, limit);
    pieces.push(...got.pieces);
    at = got.at;
    // Level with the archive, so there is no later stretch to finish a line that ends short and
    // the bite takes what is there.
    if (got.level) return { text: decode(pieces, 0, extent(pieces)), from, through: at };
    const cut = lastCut(pieces);
    if (cut !== null) return { text: decode(pieces, 0, cut.index), from, through: cut.at };
  }
};

// The window of at most `limit` bytes that ends at `to`, which is where the window after it
// begins. The head is cut forward to the first whole entry, so the two abut exactly and the entry
// they meet on is read by the later of them alone.
export const readBefore = async (bucket: R2Bucket, archive: Archive, to: number, limit: number): Promise<Bite> => {
  const pieces: Piece[] = [];
  let end = to;
  for (;;) {
    const start = Math.max(0, end - limit);
    const got = await gather(bucket, archive.parts, start, end, limit);
    pieces.unshift(...got.pieces);
    const cut = firstCut(pieces);
    if (cut !== null) return { text: decode(pieces, cut.index, extent(pieces)), from: cut.at, through: to };
    if (start === 0) return { text: decode(pieces, 0, extent(pieces)), from: 0, through: to };
    end = start;
  }
};

export const readStretch = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  to: number,
  limit: number,
): Promise<Bite> => readFrom(bucket, await archiveOf(bucket, userId, sessionId, file), from, to, limit);

// The one write an append makes, and it lands only where nothing is yet. Where the stretch starts
// is the caller's to say and the key carries it, so nothing is read first and nothing is claimed.
// The put is conditional because two writers reaching one offset hold stretches of different
// lengths — a listener's beat and a session ending read the same file at different instants — and
// letting the second write over the first would leave the longer writer's tail in no object at
// all while that writer carries on past it. The first to land wins; the loser is answered `null`
// and told where the file reaches. Where it reaches after a write is arithmetic, so that answer
// costs no read either.
export const putChunk = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  offset: number,
  body: ArrayBuffer,
): Promise<number | null> => {
  if (body.byteLength === 0) return offset;
  const written = await bucket.put(chunkKey(userId, sessionId, file, offset), body, {
    httpMetadata: { contentType: "application/x-ndjson" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written === null ? null : offset + body.byteLength;
};

// The one thing worth keeping off the objects: how far a session's own transcript runs. The
// indexer reads it on every pass and must not pay for a listing, and the stretch that moved it is
// what wakes the indexer anyway. It is folded in with MAX, so an event delivered twice, or behind
// one for a later stretch, leaves the row where the objects already put it.
//
// A delegated turn derives nothing — the index never reads one — so its stretch writes no row at
// all. The archive answers for those files by listing them, which is the only reading that can
// answer without lagging.
export const cacheChunk = (db: D1Database, chunk: Chunk): D1PreparedStatement[] =>
  chunk.file === MAIN_FILE
    ? [
        db
          .prepare(
            `INSERT INTO session_index (user_id, session_id, archived, bytes, chunks) VALUES (?1, ?2, ?3, 0, 0)
             ON CONFLICT (user_id, session_id) DO UPDATE SET archived = MAX(session_index.archived, excluded.archived)`,
          )
          .bind(chunk.userId, chunk.sessionId, chunk.end),
      ]
    : [];

// How far into each of a session's files the archive runs, counted off the objects and nothing
// else. Every caller that acts on the answer reads it here — a host working out where to send the
// rest of a file, a restore writing them back to disk, a writer told where it was beaten to an
// offset — because a count a second behind would have one of them write over a stretch or stop
// short of one.
// Which files a session archived, and nothing about how long they are. A delimited listing comes
// back one entry per file where the undelimited one comes back one per stretch, and a session
// archiving on a ten second beat holds thousands of those — a reader that only has to name the
// files must not pay to page through them.
export const archivedFileNames = async (bucket: R2Bucket, userId: string, sessionId: string): Promise<string[]> => {
  const prefix = sessionPrefix(userId, sessionId);
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor });
    for (const found of page.delimitedPrefixes) {
      const name = found.slice(prefix.length, -1);
      if (name !== "") names.push(name);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return names.sort();
};

export const archivedFiles = async (bucket: R2Bucket, userId: string, sessionId: string): Promise<TranscriptFile[]> => {
  const prefix = sessionPrefix(userId, sessionId);
  const ends = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) {
      const chunk = parseChunkKey(object.key, object.size);
      if (chunk === null) continue;
      ends.set(chunk.file, Math.max(ends.get(chunk.file) ?? 0, chunk.end));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return [...ends]
    .map(([file, bytes]): TranscriptFile => ({ file, bytes }))
    .sort((left, right) => (left.file < right.file ? -1 : 1));
};
