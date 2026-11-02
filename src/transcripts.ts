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

export interface TranscriptFile {
  file: string;
  bytes: number;
}

export type Appended = { ok: true; offset: number } | { ok: false; offset: number };

const chunkKey = (userId: string, sessionId: string, file: string, offset: number): string =>
  `${userId}/${sessionId}/${file}/${String(offset).padStart(OFFSET_DIGITS, "0")}`;

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
  return { ok: true, offset: end };
};
