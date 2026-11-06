// R2 has no append, so a session's transcript is kept as one object per appended stretch, under
// `<user id>/<session id>/<file>/<start>.<end>`. Both are zero-padded places in the file on disk:
// where the stretch begins there, and where it ends there. The key is the whole of what the
// service knows about where a stretch belongs, so a host that lost its place asks for a listing
// and resumes from the furthest place any key names — one reading, no arithmetic, and nothing to
// reconcile.
//
// Every stretch is redacted on its way up, so what an object holds is the file with its secrets
// written out as placeholders of another length. The object's size therefore says nothing about
// how much of the file it accounts for, which is why the key names the end as well as the start.
// Where a stretch sits in the archive — the concatenation a reader of the file wants — is the
// sizes of the stretches in front of it, counted off the same listing.
//
// A key of one segment is one written before redaction existed. A stretch then ran to exactly the
// bytes it was read from, so its one offset named a place in the file and in the archive at once,
// and `offset + size` named the end of both. Those keys are read on those terms for as long as
// they are there; nothing rewrites them and nothing backfills them.
//
// The object is the only write an append makes, and the key says everything about it: who, which
// session, which file and where in it. Everything else the service holds about a transcript is
// derived from that key by the consumer the storage event wakes, and nothing derived is ever
// asked a question the objects can answer, so a row that disagrees with them is wrong by
// definition and is written over by the listing that found it out.
import type { Run } from "./transcript-plan";

const OFFSET_DIGITS = 16;

// The largest stretch one call may carry. A transcript of any size lands as a run of these.
export const MAX_CHUNK_BYTES = 1_048_576;

// The name a session's own transcript is held under; mirrors MAIN in cli/src/transcripts.rs. Every
// other name is a delegated turn, which the index never reads.
export const MAIN_FILE = "main";

export interface TranscriptFile {
  file: string;
  /// How many bytes of this file the archive holds, which is the stretches it was written as laid
  /// end to end.
  bytes: number;
  /// How far into the file on disk the archive reaches, which is where a host sends on from.
  through: number;
}

const padded = (offset: number): string => String(offset).padStart(OFFSET_DIGITS, "0");

// What a stretch is stored under, past the file's prefix: where it begins in the file and where it
// ends there.
export const stretchName = (from: number, through: number): string => `${padded(from)}.${padded(through)}`;

// What a host from before redaction stores a stretch under: the one place it reached in the file
// and in the archive alike.
export const legacyStretchName = (offset: number): string => padded(offset);

const filePrefix = (userId: string, sessionId: string, file: string): string => `${userId}/${sessionId}/${file}/`;

const sessionPrefix = (userId: string, sessionId: string): string => `${userId}/${sessionId}/`;

const STRETCH_NAME = new RegExp(`^([0-9]{${OFFSET_DIGITS}})(?:\\.([0-9]{${OFFSET_DIGITS}}))?$`);

// Whether one name is a stretch's, which is what says a key is one the archive wrote.
export const isStretchName = (name: string): boolean => STRETCH_NAME.test(name);

// Who wrote which file of which session, read off whatever named it: an object a listing caught,
// or the key a storage event carries. A key the archive did not write, and an event for anything
// but a write, is no stretch and is passed over rather than guessed at.
export interface Stretched {
  userId: string;
  sessionId: string;
  file: string;
}

export const parseChunkKey = (key: string): Stretched | null => {
  const [userId, sessionId, file, name, ...rest] = key.split("/");
  if (userId === undefined || sessionId === undefined || file === undefined || name === undefined) return null;
  if (rest.length > 0 || userId === "" || sessionId === "" || file === "") return null;
  if (!isStretchName(name)) return null;
  return { userId, sessionId, file };
};

interface Span {
  from: number;
  to: number;
}

// One stretch of one file: the name it is stored under, the span of the file it accounts for, and
// the span of the archive its bytes occupy.
interface Stretch {
  name: string;
  source: Span;
  archive: Span;
}

// How the stretches of one file lay out, in the order the file puts them. A one-segment name is
// read on the terms it was written under: it names a place in the file and in the archive at once,
// and the stretch runs to its own size in both, which is what lets one overlapping the stretch in
// front of it be trimmed back to the bytes the file has not already had.
//
// A two-segment name says where in the file the stretch begins and ends, and where it sits in the
// archive is the sizes of the stretches in front of it. One of those cannot be trimmed: what it
// holds is the file redacted, and no count of those bytes answers for a place in the file. So where
// two of them begin at one place — two writers that read the file at different instants, each told
// the archive reached there — the longer is the one read and the other is passed over whole, which
// leaves the archive accounting for every byte of the file exactly once.
const laidOut = (listed: Array<{ name: string; size: number }>): Stretch[] => {
  const parsed: Array<{ name: string; size: number; source: Span; named: boolean }> = [];
  for (const object of listed) {
    const found = STRETCH_NAME.exec(object.name);
    const opens = found?.[1];
    if (opens === undefined) continue;
    const from = Number(opens);
    const end = found?.[2];
    parsed.push({
      name: object.name,
      size: object.size,
      source: { from, to: end === undefined ? from + object.size : Number(end) },
      named: end !== undefined,
    });
  }
  parsed.sort((left, right) => left.source.from - right.source.from || right.source.to - left.source.to);
  const held: Stretch[] = [];
  let source = 0;
  let archive = 0;
  for (const part of parsed) {
    if (!part.named) {
      held.push({ name: part.name, source: part.source, archive: part.source });
      source = Math.max(source, part.source.to);
      archive = Math.max(archive, part.source.to);
      continue;
    }
    if (part.source.from < source) continue;
    held.push({ name: part.name, source: part.source, archive: { from: archive, to: archive + part.size } });
    source = part.source.to;
    archive += part.size;
  }
  return held;
};

const listedNames = async (bucket: R2Bucket, prefix: string): Promise<Array<{ name: string; size: number }>> => {
  const found: Array<{ name: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) found.push({ name: object.key.slice(prefix.length), size: object.size });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return found;
};

// The stretches one file was written as, laid out off one listing of its prefix.
const stretches = (bucket: R2Bucket, userId: string, sessionId: string, file: string): Promise<Stretch[]> =>
  listedNames(bucket, filePrefix(userId, sessionId, file)).then(laidOut);

const keyOf = (userId: string, sessionId: string, file: string, name: string): string =>
  `${filePrefix(userId, sessionId, file)}${name}`;

// One of a session's transcript files, read back whole as the concatenation of its stretches. The
// body is streamed rather than gathered: a long session's transcript runs to megabytes, and a
// reader restoring one writes it out as it arrives. The reads come off the runs rather than the
// objects, so a stretch overlapping the one in front of it hands over only the bytes the file has
// not already had.
export const readTranscript = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<ReadableStream<Uint8Array> | null> => {
  const runs = runsOf(await stretches(bucket, userId, sessionId, file));
  const reads = runs.flatMap((run) => run.reads);
  if (reads.length === 0) return null;
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = reads[next];
      if (read === undefined) {
        controller.close();
        return;
      }
      next += 1;
      const object = await bucket.get(keyOf(userId, sessionId, file, read.at), {
        range: { offset: read.skip, length: read.bytes },
      });
      if (object === null) throw new Error(`the archive lost ${read.at} of ${file}`);
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
};

export interface Bite {
  text: string;
  /// Where in the archive this bite ends, as a position in it and never a count of bytes read.
  /// The two part company over a hole, and a mark that could mean either would have a reader
  /// index prose it already held or skip prose it never did.
  through: number;
}

// One bite of a file's archive, from `from` and at most `limit` bytes, for a reader that will come
// back for the rest. `through` always moves while stretches are left: a reader that takes it as
// its mark cannot be handed the same bite twice, whatever the archive holds.
//
// A hole is a run of bytes no object covers, which is what a stretch sent past the end of the
// file leaves behind. Those bytes exist nowhere, so the read steps over the hole to the next
// stretch rather than reading across it as though the file ran on.
export const readStretch = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  to: number,
  limit: number,
): Promise<Bite> => {
  const parts = await stretches(bucket, userId, sessionId, file);
  const read: Uint8Array[] = [];
  let at = from;
  let held = 0;
  while (at < to && held < limit) {
    const covering = parts.find((part) => part.archive.from <= at && part.archive.to > at);
    const part = covering ?? parts.find((part) => part.archive.from > at);
    if (part === undefined) break;
    at = Math.max(at, part.archive.from);
    const offset = at - part.archive.from;
    const length = Math.min(part.archive.to - at, limit - held, to - at);
    if (length <= 0) break;
    const object = await bucket.get(keyOf(userId, sessionId, file, part.name), { range: { offset, length } });
    if (object === null) throw new Error(`the archive lost ${part.name} of ${file}`);
    const body = new Uint8Array(await object.arrayBuffer());
    read.push(body);
    held += body.byteLength;
    at += body.byteLength;
  }
  const bytes = new Uint8Array(held);
  let written = 0;
  for (const body of read) {
    bytes.set(body, written);
    written += body.byteLength;
  }
  const line = bytes.lastIndexOf(10) + 1;
  // Level with the archive, so there is no later stretch to finish a line that ends short; the
  // mark takes the whole bite. Stopped early, so the last line may yet be completed by bytes that
  // have not arrived, and the mark holds back to the last one that is whole — unless the bite
  // holds no line end at all, which is one entry longer than a bite and never worth waiting for.
  const through = at >= to ? to : from + (line > 0 ? line : held);
  return { text: new TextDecoder().decode(bytes.subarray(0, at >= to ? held : line || held)), through };
};

export interface ArchivedFile {
  file: string;
  bytes: number;
  through: number;
  runs: Run[];
}

// How one file lays out in the archive: the runs of it every byte of which sits in some object. A
// run carries on while the next stretch is contiguous in the archive and in the file alike, since
// a stretch that opens past where the file has been accounted for leaves bytes in no object and
// the lines either side of that gap do not join up.
const runsOf = (parts: Stretch[]): Run[] => {
  const runs: Run[] = [];
  let through = 0;
  for (const part of parts) {
    const run = runs[runs.length - 1];
    if (run !== undefined && part.archive.from <= run.to && part.source.from <= through) {
      through = Math.max(through, part.source.to);
      if (part.archive.to <= run.to) continue;
      run.reads.push({
        at: part.name,
        offset: part.archive.from,
        skip: run.to - part.archive.from,
        bytes: part.archive.to - run.to,
      });
      run.to = part.archive.to;
      continue;
    }
    if (part.archive.to === part.archive.from) continue;
    through = part.source.to;
    runs.push({
      from: part.archive.from,
      to: part.archive.to,
      reads: [{ at: part.name, offset: part.archive.from, skip: 0, bytes: part.archive.to - part.archive.from }],
    });
  }
  return runs;
};

const archivedFile = (file: string, parts: Stretch[]): ArchivedFile => {
  const runs = runsOf(parts);
  return {
    file,
    bytes: runs[runs.length - 1]?.to ?? 0,
    through: parts.reduce((furthest, part) => Math.max(furthest, part.source.to), 0),
    runs,
  };
};

// Every file a session archived and how each is laid out across objects, off one listing of the
// session's prefix and nothing else. It opens no object: a reader hands this to the browser, which
// fetches the bytes it wants against it.
export const archivedTranscript = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
): Promise<ArchivedFile[]> => {
  const prefix = sessionPrefix(userId, sessionId);
  const byFile = new Map<string, Array<{ name: string; size: number }>>();
  for (const object of await listedNames(bucket, prefix)) {
    const [file, name, ...rest] = object.name.split("/");
    if (file === undefined || file === "" || name === undefined || rest.length > 0) continue;
    if (!isStretchName(name)) continue;
    const held = byFile.get(file);
    if (held === undefined) byFile.set(file, [{ name, size: object.size }]);
    else held.push({ name, size: object.size });
  }
  return [...byFile]
    .map(([file, listed]) => archivedFile(file, laidOut(listed)))
    .sort((left, right) => (left.file < right.file ? -1 : 1));
};

// How many reads one beat of a following box is handed. A reader takes what its own step allows
// and comes straight back for the rest, so a tab that woke to a day of writing catches up over
// several beats rather than being handed thousands of reads it has no budget to fetch.
const TAIL_LISTED_READS = 1_000;

// How one file lays out past where a reader has read to, for a box following a session still
// writing it. Where a stretch sits in the archive is the sizes of the stretches in front of it, so
// the whole of the prefix is listed to place the end of it; what comes back is only the reads that
// reach past the reader, and the oldest of those holds the bytes it wants next.
//
// A read the reader is part way through comes back whole, so the stretch straddling its cursor is
// named too: it reads forward from its own byte cursor across whatever comes back.
export const archivedSince = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
): Promise<Run[]> => {
  const kept: Run[] = [];
  let budget = TAIL_LISTED_READS;
  for (const run of runsOf(await stretches(bucket, userId, sessionId, file))) {
    if (budget <= 0) break;
    const reads = run.reads.filter((read) => read.offset + read.skip + read.bytes > from).slice(0, budget);
    const head = reads[0];
    const last = reads[reads.length - 1];
    if (head === undefined || last === undefined) continue;
    budget -= reads.length;
    kept.push({ from: head.offset + head.skip, to: last.offset + last.skip + last.bytes, reads });
  }
  return kept;
};

// One stretch, opened by the name it is stored under and ranged by what the caller asked for.
// Nothing is listed and nothing is parsed: a manifest already said which stretches a file holds,
// and this hands back the bytes of one of them.
export const readChunk = (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  name: string,
  range: R2Range,
): Promise<R2ObjectBody | null> => bucket.get(keyOf(userId, sessionId, file, name), { range });

// The one write an append from a host before redaction makes, and it lands only where nothing is
// yet. Where the stretch begins in the archive is that caller's to say and the key carries it, so
// nothing is read first and nothing is claimed; a second writer reaching the same place is
// answered `false` and told how far the archive runs rather than writing over the first.
export const putStretch = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  name: string,
  body: ArrayBuffer,
): Promise<boolean> => {
  const written = await bucket.put(keyOf(userId, sessionId, file, name), body, {
    httpMetadata: { contentType: "application/x-ndjson" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written !== null;
};

export type Appended = { kind: "written"; through: number } | { kind: "refused"; through: number };

// One stretch of a file, taken only where the archive reaches exactly the place in the file the
// stretch begins at. Two writers read one file at different instants — a listener's beat and a
// session ending — and hold stretches that begin together and end apart. The key names both ends,
// so those two would land beside each other and the archive would account for the span they share
// twice; and nothing can be trimmed off the head of the second, since what it holds is the file
// redacted and no count of those bytes answers for a place in the file.
//
// So how far the archive reaches is read first, and that is what a stretch is weighed against. It
// costs a listing of the file's prefix, which is the price of an archive that accounts for every
// byte of a file exactly once however many writers reach it. The loser is answered the reach,
// which is where its next stretch begins. Two appends whose listings both land before either write
// leave one stretch read and the other passed over, and the next append from the writer that was
// passed over is refused and told the reach, so the file comes back to one writer within a beat.
export const appendStretch = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  through: number,
  body: ArrayBuffer,
): Promise<Appended> => {
  const reach = await archivedThrough(bucket, userId, sessionId, file);
  if (reach !== from) return { kind: "refused", through: reach };
  // A key already there names this same span of the same file, so the stretch is accounted for
  // whichever writer put it there and the first to land is the one kept.
  await putStretch(bucket, userId, sessionId, file, stretchName(from, through), body);
  return { kind: "written", through };
};

// The one thing worth keeping off the objects: how many bytes of a session's own transcript the
// archive holds. The indexer reads it on every pass and must not pay for a listing, and the
// stretch that moved it is what wakes the indexer anyway. It is folded in with MAX, so an event
// delivered twice, or behind one for a later stretch, leaves the row where the objects already put
// it.
//
// A delegated turn derives nothing — the index never reads one — so its stretch writes no row at
// all. The archive answers for those files by listing them, which is the only reading that can
// answer without lagging.
export const cacheChunk = (db: D1Database, userId: string, sessionId: string, archived: number): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO session_index (user_id, session_id, archived, bytes, chunks) VALUES (?1, ?2, ?3, 0, 0)
       ON CONFLICT (user_id, session_id) DO UPDATE SET archived = MAX(session_index.archived, excluded.archived)`,
    )
    .bind(userId, sessionId, archived);

// How many bytes of one file the archive holds, counted off the objects. It is what the index and
// a following box are weighed against, and a key and a size on their own cannot say it: an
// object's place in the archive is the sizes of the objects in front of it.
export const archivedBytes = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<number> => {
  const runs = runsOf(await stretches(bucket, userId, sessionId, file));
  return runs[runs.length - 1]?.to ?? 0;
};

// How far into one file on disk the archive reaches, counted off the keys. It is the one place a
// host sends on from and the one a restore weighs a local file against.
export const archivedThrough = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<number> =>
  (await stretches(bucket, userId, sessionId, file)).reduce((furthest, part) => Math.max(furthest, part.source.to), 0);

// How far into each of a session's files the archive reaches, counted off the objects and nothing
// else. Every caller that acts on the answer reads it here — a host working out where to send the
// rest of a file, a restore writing them back to disk, a writer told where it was beaten to a
// place — because a count a second behind would have one of them write over a stretch or stop
// short of one.
export const archivedFiles = async (bucket: R2Bucket, userId: string, sessionId: string): Promise<TranscriptFile[]> =>
  (await archivedTranscript(bucket, userId, sessionId)).map(
    ({ file, bytes, through }): TranscriptFile => ({ file, bytes, through }),
  );
