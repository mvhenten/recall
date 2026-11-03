// R2 has no append, so a session's transcript is kept as one object per appended stretch, under
// `<user id>/<session id>/<file>/<start offset>`. The offset is zero-padded, so listing the prefix
// gives the stretches in the order they were written and reading one file is a concatenation. A
// stretch is keyed by where it starts and nothing else, so a tick that retries one writes the same
// key again instead of a second copy of the same lines.
//
// Where a file ends is kept in D1 beside the session rather than counted off the objects. A
// running session appends every few seconds, so listing the prefix on every call would cost a
// listing that grows with the session and make archiving a long one quadratic.
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

export type Appended = { ok: true; offset: number } | { ok: false; offset: number };

const chunkKey = (userId: string, sessionId: string, file: string, offset: number): string =>
  `${userId}/${sessionId}/${file}/${String(offset).padStart(OFFSET_DIGITS, "0")}`;

const filePrefix = (userId: string, sessionId: string, file: string): string => `${userId}/${sessionId}/${file}/`;

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
  return found;
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
// the rest. `through` always moves: a reader that takes it as its mark cannot be handed the same
// bite twice, whatever the archive holds.
//
// A hole is a stretch whose end was claimed and whose object never landed, which is what an
// isolate killed between the two leaves behind. Those bytes exist nowhere and never will, so the
// read steps over the hole to the next stretch rather than reading across it as though the file
// ran on; a reader stopping short of it instead would find the session due for good.
export const readStretch = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  to: number,
  limit: number,
): Promise<Bite> => {
  const parts = (await stretches(bucket, userId, sessionId, file)).sort((left, right) => left.from - right.from);
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

// How far the archive holds a session's own transcript, which is what puts the session in the
// indexer's queue. It is moved by the append that wrote those bytes, so the queue costs the
// indexer no scan of its own, and it never moves backwards: a stretch refused for landing
// anywhere but the end of the file says nothing about where the file ends.
const markArchived = (db: D1Database, userId: string, sessionId: string, end: number): Promise<unknown> =>
  db
    .prepare(
      `INSERT INTO session_index (user_id, session_id, archived, bytes, chunks, indexed_at)
       VALUES (?1, ?2, ?3, 0, 0, 0)
       ON CONFLICT (user_id, session_id) DO UPDATE SET archived = MAX(session_index.archived, excluded.archived)`,
    )
    .bind(userId, sessionId, end)
    .run();

// How far into each of a session's transcript files this service has been written, which is where
// the host that holds them picks up. A file nothing was ever written for is simply absent.
export const transcriptFiles = async (db: D1Database, userId: string, sessionId: string): Promise<TranscriptFile[]> => {
  const { results } = await db
    .prepare("SELECT file, bytes FROM transcript_files WHERE user_id = ? AND session_id = ? ORDER BY file")
    .bind(userId, sessionId)
    .all<TranscriptFile>();
  return results;
};

const heldBytes = async (db: D1Database, userId: string, sessionId: string, file: string): Promise<number> => {
  const row = await db
    .prepare("SELECT bytes FROM transcript_files WHERE user_id = ? AND session_id = ? AND file = ?")
    .bind(userId, sessionId, file)
    .first<{ bytes: number }>();
  return row?.bytes ?? 0;
};

// Moving the end of a file from where a stretch starts to where it finishes, and only from there.
// Two writers reaching the same file at once — the listener's beat and a session ending — both
// read the same end and offer a stretch from it; this is what picks one. The loser changes no row
// and is told where the file ends now.
const claim = async (
  db: D1Database,
  userId: string,
  sessionId: string,
  file: string,
  offset: number,
  end: number,
): Promise<boolean> => {
  // A file the service holds nothing of has no row, and the only stretch that may open one is the
  // one starting at nothing. An update alone would let a stretch from the middle of a file open a
  // file that begins at its own offset.
  const claimed =
    offset === 0
      ? await db
          .prepare(
            `INSERT INTO transcript_files (user_id, session_id, file, bytes) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (user_id, session_id, file) DO UPDATE SET bytes = ?4 WHERE transcript_files.bytes = 0`,
          )
          .bind(userId, sessionId, file, end)
          .run()
      : await db
          .prepare(
            `UPDATE transcript_files SET bytes = ?4
             WHERE user_id = ?1 AND session_id = ?2 AND file = ?3 AND bytes = ?5`,
          )
          .bind(userId, sessionId, file, end, offset)
          .run();
  return claimed.meta.changes === 1;
};

// The store is append-only: a stretch lands only where the file already ends, so two writers
// racing on the same file cannot leave an overlap, or a hole, for a reader to find. A caller
// writing anywhere else is told where the file ends and reads on from there.
//
// The end moves before the object goes down, and that order is the whole of it. Writing first
// would have the slower of two writers put its shorter stretch over the longer one already
// there, leaving the file ending past bytes nothing holds — a hole no reader could see, since
// every object either side of it is exactly where it should be. Claiming first means the loser
// never writes at all. A put that then fails gives the claim back, so the next stretch starts
// where this one did rather than beyond a gap.
export const appendChunk = async (
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  offset: number,
  body: ArrayBuffer,
): Promise<Appended> => {
  if (body.byteLength === 0) {
    const held = await heldBytes(db, userId, sessionId, file);
    return offset === held ? { ok: true, offset: held } : { ok: false, offset: held };
  }
  const end = offset + body.byteLength;
  if (!(await claim(db, userId, sessionId, file, offset, end))) {
    return { ok: false, offset: await heldBytes(db, userId, sessionId, file) };
  }
  await bucket
    .put(chunkKey(userId, sessionId, file, offset), body, {
      httpMetadata: { contentType: "application/x-ndjson" },
    })
    .catch(async (failure: unknown) => {
      await claim(db, userId, sessionId, file, end, offset);
      throw failure;
    });
  if (file === MAIN_FILE) await markArchived(db, userId, sessionId, end);
  return { ok: true, offset: end };
};
