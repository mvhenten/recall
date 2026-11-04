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
  /// Where in the file this bite ends, as a position in the file and never a count of bytes read.
  /// The two part company over a hole, and a mark that could mean either would have a reader
  /// index prose it already held or skip prose it never did.
  through: number;
}

// One bite of a file, from `from` and at most `limit` bytes, for a reader that will come back for
// the rest. `through` always moves while stretches are left: a reader that takes it as its mark
// cannot be handed the same bite twice, whatever the archive holds.
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
    const covering = parts.find((part) => part.from <= at && part.from + part.bytes > at);
    const part = covering ?? parts.find((part) => part.from > at);
    if (part === undefined) break;
    at = Math.max(at, part.from);
    const offset = at - part.from;
    const length = Math.min(part.bytes - offset, limit - held, to - at);
    if (length <= 0) break;
    const object = await bucket.get(part.key, { range: { offset, length } });
    if (object === null) throw new Error(`the archive lost ${part.key}`);
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

export interface ArchivedFile {
  file: string;
  bytes: number;
  runs: Run[];
}

const runsOf = (parts: Chunk[]): Run[] => {
  const runs: Run[] = [];
  for (const part of parts) {
    const run = runs[runs.length - 1];
    if (run !== undefined && part.offset <= run.to) {
      if (part.end <= run.to) continue;
      run.reads.push({ offset: part.offset, skip: run.to - part.offset, bytes: part.end - run.to });
      run.to = part.end;
      continue;
    }
    if (part.end === part.offset) continue;
    runs.push({
      from: part.offset,
      to: part.end,
      reads: [{ offset: part.offset, skip: 0, bytes: part.end - part.offset }],
    });
  }
  return runs;
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
  const byFile = new Map<string, Chunk[]>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) {
      const chunk = parseChunkKey(object.key, object.size);
      if (chunk === null) continue;
      const held = byFile.get(chunk.file);
      if (held === undefined) byFile.set(chunk.file, [chunk]);
      else held.push(chunk);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return [...byFile]
    .map(([file, parts]): ArchivedFile => {
      const runs = runsOf(parts.sort((left, right) => left.offset - right.offset));
      return { file, bytes: runs[runs.length - 1]?.to ?? 0, runs };
    })
    .sort((left, right) => (left.file < right.file ? -1 : 1));
};

// One stretch, opened by the key its offset names and ranged by what the caller asked for. Nothing
// is listed and nothing is parsed: a manifest already said which stretches a file holds, and this
// hands back the bytes of one of them.
export const readChunk = (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  offset: number,
  range: R2Range,
): Promise<R2ObjectBody | null> => bucket.get(chunkKey(userId, sessionId, file, offset), { range });

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
export const archivedFiles = async (bucket: R2Bucket, userId: string, sessionId: string): Promise<TranscriptFile[]> =>
  (await archivedTranscript(bucket, userId, sessionId)).map(({ file, bytes }): TranscriptFile => ({ file, bytes }));
