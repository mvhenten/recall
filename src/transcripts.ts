// R2 has no append, so a session's transcript is kept as one object per appended stretch, under
// `<user id>/<session id>/<file>/<start>.<end>.<inflates>`. The first two are zero-padded places in
// the file on disk — where the stretch begins there and where it ends there — and the third is how
// many bytes of it the gzipped object holds. The key is the whole of what the service knows about
// where a stretch belongs, so a host that lost its place asks for a listing and resumes from the
// furthest place any key names — one reading, no arithmetic, and nothing to reconcile.
//
// Every stretch is redacted on its way up, so what an object holds is the file with its secrets
// written out as placeholders of another length. The object's size therefore says nothing about
// how much of the file it accounts for, which is why the key names the end as well as the start.
// Where a stretch sits in the archive — the concatenation a reader of the file wants — is the
// sizes of the stretches in front of it, counted off the same listing.
//
// A key of one segment names one number, and what that number means depends on the host that wrote
// it. Before redaction a stretch ran to exactly the bytes it was read from, so the one offset named
// a place in the file and in the archive at once and `offset + size` named the end of both. v0.15.0
// and v0.16.0 redacted and still wrote one offset, and there it is a place in the archive over a
// body of another length than the span of the file it accounts for, so `offset + size` is no place
// in the file at all. Those two releases must never be installed on a host: a host goes from 0.14.0
// or earlier straight to the release that keys both ends.
//
// So a reach resting on a key of one segment is handed over as what it is, and a host or a restore
// told a number the file on disk disagrees with bails rather than reading on. Nothing rewrites those
// keys and nothing backfills them.
//
// A stretch goes up gzipped, which is where the third segment comes from. A transcript is prose and
// JSON and compresses to under a third of itself, and a gzip member has no inner range: nothing can
// read one part way, and nothing reads how long it inflates to without inflating it. So the name
// says that too, and the one number every placing of a stretch in the archive rests on comes off the
// listing rather than off the object. The append takes it by inflating the member once, since no
// caller may say how much of the file a body it sends holds. A key of two segments is a stretch
// stored as it stands, which is everything the archive holds from before this and every stretch a
// host that has yet to learn to compress one sends; both forms are read and neither is rewritten.
//
// The key says everything about one object: who, which session, which file and where in it. An
// append weighs its stretch against one listing of the file's prefix, and the one number worth
// keeping off that listing — how many bytes of the session's own transcript the archive holds — is
// written down beside the object rather than counted a second time by the consumer the storage
// event wakes. Counting it there would have cost a listing of the whole prefix per stretch, which
// is the length of the session; the price is a second write on the append path, and a row left
// standing ahead of the objects where one of them is lost outright. Nothing derived is ever asked
// a question the objects can answer, so every reading that must not lag lists them.
import {
  compressedStretchName,
  isStretchName,
  legacyStretchName,
  type NamedStretch,
  namedStretch,
  type Run,
  stretchName,
} from "./transcript-plan";

// The largest stretch one call may carry. A transcript of any size lands as a run of these.
export const MAX_STRETCH_BYTES = 1_048_576;

// The name a session's own transcript is held under. Every other name is a delegated turn, which
// the index never reads.
export const MAIN_FILE = "main";

// How far into one file on disk the archive reaches, and whether every key behind that number
// names both ends of the span it holds. One key of one segment anywhere behind the reach leaves it
// unproven: only a host that did not redact meant a place in the file by such a number, and the
// keys past it are read off where that one left the file. So the two are handed over said apart.
export interface Extent {
  through: number;
  named: boolean;
}

export interface TranscriptFile extends Extent {
  file: string;
  /// How many bytes of this file the archive holds, which is the stretches it was written as laid
  /// end to end.
  bytes: number;
}

// One file of a session as `/v2` answers for it, said apart by the path that wrote it. The two
// answer in places of different kinds — a stretch names a byte of the file on disk, and a record
// names a line of it, which redaction cannot move — so which number a reader weighs its own copy
// against follows from `held` and from nothing else. A file held as records reaches nowhere into
// the file on disk: its `bytes` are a length of the archive, and the records are the one count
// that is a place in both.
export type HeldFile =
  | ({ held: "bytes"; file: string; bytes: number } & Extent)
  | { held: "records"; file: string; bytes: number; records: number };

const filePrefix = (userId: string, sessionId: string, file: string): string => `${userId}/${sessionId}/${file}/`;

const sessionPrefix = (userId: string, sessionId: string): string => `${userId}/${sessionId}/`;

// Who wrote which file of which session, read off whatever named it: an object a listing caught,
// or the key a storage event carries. A key the archive did not write, and an event for anything
// but a write, is no stretch and is passed over rather than guessed at.
export interface Stretched {
  userId: string;
  sessionId: string;
  file: string;
}

export const parseStretchKey = (key: string): Stretched | null => {
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

// One stretch of one file: the name it is stored under, which of the three forms that name is in,
// the span of the file it accounts for, and the span of the archive those bytes occupy.
interface Stretch {
  name: string;
  form: NamedStretch["form"];
  source: Span;
  archive: Span;
}

// One object of one file's prefix, read off its name and its size and nothing else. It is the one
// reading of a name there is: every layout below is handed these.
interface Listed {
  name: string;
  form: NamedStretch["form"];
  /// How many bytes of the archive this object accounts for: what its name says it inflates to
  /// where it is stored gzipped, and its own size where it holds those bytes as they stand.
  holds: number;
  source: Span;
}

const listedStretch = (name: string, size: number): Listed | null => {
  const named = namedStretch(name);
  if (named === null) return null;
  if (named.form === "place") {
    return { name, form: "place", holds: size, source: { from: named.from, to: named.from + size } };
  }
  if (named.form === "span") {
    return { name, form: "span", holds: size, source: { from: named.from, to: named.through } };
  }
  return { name, form: "packed", holds: named.inflates, source: { from: named.from, to: named.through } };
};

// Where a page of a listing that does not open at a file's first object begins: how far into the
// archive and how far into the file the stretches in front of the page already reach. A page read
// from the first object needs neither, and a page the reader's cursor opens needs both — a key can
// sort past that cursor and still name a span the stretch the cursor names already accounted for,
// which is what two writers racing one append leave behind.
interface Opens {
  archive: number;
  source: number;
}

const FIRST_OBJECT: Opens = { archive: 0, source: 0 };

// How the stretches of one file lay out, in the order the file puts them, from `opens`. A
// one-segment name is read on the terms it was written under: it names a place in the file and in
// the archive at once, and the stretch runs to its own size in both, which is what lets one
// overlapping the stretch in front of it be trimmed back to the bytes the file has not already had.
//
// A name of two segments or three says where in the file the stretch begins and ends, and where it
// sits in the archive is the lengths of the stretches in front of it — each of those its own size
// where it is stored as it stands, and what its name says it inflates to where it is stored
// gzipped. One of those cannot be trimmed: what it holds is the file redacted, and no count of
// those bytes answers for a place in the file. So where two of them begin at one place — two
// writers that read the file at different instants, each told the archive reached there — the longer
// is the one read and the other is passed over whole, which leaves the archive accounting for every
// byte of the file exactly once.
//
// A one-segment name shares no scale with the other two, so a file that holds both is read on the
// later form's terms: once a name of two segments or three has been seen, every one-segment name
// past it is passed over. Mixing them would lay the same file out as runs with holes between them
// and place reads inside the wrong objects, and nothing in the archive says which of two numbers at
// one place means which.
const laidOut = (listed: Listed[], opens: Opens = FIRST_OBJECT): Stretch[] => {
  const parsed = [...listed].sort(
    (left, right) => left.source.from - right.source.from || right.source.to - left.source.to,
  );
  const held: Stretch[] = [];
  let source = opens.source;
  let archive = opens.archive;
  let spanned = false;
  for (const part of parsed) {
    if (part.form === "place") {
      if (spanned) continue;
      held.push({ name: part.name, form: part.form, source: part.source, archive: part.source });
      source = Math.max(source, part.source.to);
      archive = Math.max(archive, part.source.to);
      continue;
    }
    spanned = true;
    if (part.source.from < source) continue;
    held.push({
      name: part.name,
      form: part.form,
      source: part.source,
      archive: { from: archive, to: archive + part.holds },
    });
    source = part.source.to;
    archive += part.holds;
  }
  return held;
};

const listedNames = async (bucket: R2Bucket, prefix: string): Promise<Listed[]> => {
  const found: Listed[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) {
      const stretch = listedStretch(object.key.slice(prefix.length), object.size);
      if (stretch !== null) found.push(stretch);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return found;
};

// The stretches one file was written as, laid out off one listing of its prefix.
const stretches = (bucket: R2Bucket, userId: string, sessionId: string, file: string): Promise<Stretch[]> =>
  listedNames(bucket, filePrefix(userId, sessionId, file)).then((listed) => laidOut(listed));

const keyOf = (userId: string, sessionId: string, file: string, name: string): string =>
  `${filePrefix(userId, sessionId, file)}${name}`;

// One gzip member as the file holds it. There is no reading one part way, so it is inflated whole,
// which is why how much it holds is in its name rather than left to be found out.
const inflated = async (body: ArrayBuffer): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
  );

// The bytes of one stretch from `offset` in it and at most `length` of them. A stretch stored as it
// stands is ranged inside the object; a gzip member has no inner range, so that one comes down
// whole and the span is taken out of what it inflates to.
const stretchBytes = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  part: Stretch,
  offset: number,
  length: number,
): Promise<Uint8Array> => {
  const key = keyOf(userId, sessionId, file, part.name);
  const packed = part.form === "packed";
  const object = packed ? await bucket.get(key) : await bucket.get(key, { range: { offset, length } });
  if (object === null) throw new Error(`the archive lost ${part.name} of ${file}`);
  const body = await object.arrayBuffer();
  return packed ? (await inflated(body)).subarray(offset, offset + length) : new Uint8Array(body);
};

// One of a session's transcript files, and whether what comes back is the gzip members it is stored
// as or the bytes of the file itself. Nothing is gathered: a long session's transcript runs to
// megabytes, and a reader restoring one writes it out as it arrives.
export interface Archived {
  body: ReadableStream<Uint8Array>;
  gzip: boolean;
}

// One of a session's transcript files, read back whole as the concatenation of its stretches. The
// reads come off the runs rather than the objects, so a stretch overlapping the one in front of it
// hands over only the bytes the file has not already had.
//
// A run boundary is a hole: the bytes between the two runs are in no object, and the line the file
// ran on with across them is in no object either. So a newline is handed over at every boundary,
// which leaves the tail of the run in front and the head of the one behind as two part lines rather
// than one line the file never held. A part line fails to parse and a reader can pass it over; a
// line made of two unrelated fragments parses, and nothing downstream can tell it from a real one.
// A file of one run — which is every file the archive accounts for whole — is handed over untouched.
//
// Gzip members laid end to end are one gzip stream, so a file of one run every stretch of which is
// stored gzipped is handed over as it stands and inflated by the reader — no byte of it is touched
// here, and a third of them go over the wire. A file holding one stretch stored as it stands is not
// that stream, and neither is one a newline has to go into, so those are inflated here instead and
// go over as the bytes of the file: the answer is encoded one way throughout, and a caller that does
// not take gzip is answered that way too.
export const readTranscript = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  takesGzip: boolean,
): Promise<Archived | null> => {
  const parts = await stretches(bucket, userId, sessionId, file);
  const byName = new Map(parts.map((part) => [part.name, part]));
  const runs = runsOf(parts);
  const reads = runs.flatMap((run, index) =>
    run.reads.map((read, taken) => ({ read, seam: index > 0 && taken === 0 })),
  );
  if (reads.length === 0) return null;
  const gzip = takesGzip && runs.length === 1 && reads.every(({ read }) => byName.get(read.at)?.form === "packed");
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const handed = reads[next];
      if (handed === undefined) {
        controller.close();
        return;
      }
      next += 1;
      const part = byName.get(handed.read.at);
      if (part === undefined) throw new Error(`the archive lost ${handed.read.at} of ${file}`);
      if (handed.seam) controller.enqueue(new Uint8Array([10]));
      if (!gzip) {
        const { skip, bytes } = handed.read;
        controller.enqueue(await stretchBytes(bucket, userId, sessionId, file, part, skip, bytes));
        return;
      }
      const object = await bucket.get(keyOf(userId, sessionId, file, part.name));
      if (object === null) throw new Error(`the archive lost ${part.name} of ${file}`);
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
  return { body, gzip };
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
// A hole is a run of bytes no object covers, which is what a stretch stored past the end of what
// the archive accounts for leaves behind. A two-segment name lands only where the archive reaches
// exactly the place in the file the stretch begins at, so a file keyed in that form holds no hole
// and the step below is reached only by the one-segment form, where a key named a place nothing had
// reached. Those bytes exist nowhere, so the read steps over the hole to the next stretch rather
// than reading across it as though the file ran on.
//
// This is the one reading of the archive that inflates a stretch in the service. It is the indexer,
// which wants a window of the prose in the middle of an object and no gzip member can be opened
// there; every other reader is handed the member and inflates it itself. The append inflates one
// too, to take the length its name carries, and keeps no byte of what comes out.
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
    const body = await stretchBytes(bucket, userId, sessionId, file, part, offset, length);
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

export interface ArchivedFile extends Extent {
  file: string;
  bytes: number;
  runs: Run[];
}

// How far into the file the stretches of it reach, and whether the key that said so named both
// ends. One key of one segment anywhere behind the reach is enough to leave it unproven: the
// number it names is a place in the file only if the host that wrote it did not redact, and the
// keys past it are read off where that one left the file.
const extentOf = (parts: Stretch[]): Extent =>
  parts.reduce<Extent>(
    (reach, part) => ({
      through: Math.max(reach.through, part.source.to),
      named: reach.named && part.form !== "place",
    }),
    { through: 0, named: true },
  );

// How one file lays out in the archive: the runs of it every byte of which sits in some object. A
// run carries on while the next stretch is contiguous in the archive and in the file alike, since
// a stretch that opens past where the file has been accounted for leaves bytes in no object and
// the lines either side of that gap do not join up.
//
// That second reading is what the branch below trims an overlap against, and only the one-segment
// form can reach it: a two-segment name lands where the archive reaches exactly the place in the
// file it begins at, so two of those neither overlap nor leave a gap.
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
  return { file, bytes: runs[runs.length - 1]?.to ?? 0, ...extentOf(parts), runs };
};

// Every file a session archived and how each is laid out across objects, off one listing of the
// session's prefix and nothing else. It opens no object: a reader hands this to the browser, which
// fetches the bytes it wants against it.
//
// A listing of the session's prefix catches the objects of every file at once, so the name is read
// here rather than under the file prefix: a key the archive did not write names no file and makes
// none appear.
export const archivedTranscript = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
): Promise<ArchivedFile[]> => {
  const prefix = sessionPrefix(userId, sessionId);
  const byFile = new Map<string, Listed[]>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) {
      const [file, name, ...rest] = object.key.slice(prefix.length).split("/");
      if (file === undefined || file === "" || name === undefined || rest.length > 0) continue;
      const stretch = listedStretch(name, object.size);
      if (stretch === null) continue;
      const held = byFile.get(file);
      if (held === undefined) byFile.set(file, [stretch]);
      else held.push(stretch);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return [...byFile]
    .map(([file, listed]) => archivedFile(file, laidOut(listed)))
    .sort((left, right) => (left.file < right.file ? -1 : 1));
};

// How many reads one beat of a following box is handed. A reader takes what its own step allows
// and comes straight back for the rest, so a tab that woke to a day of writing catches up over
// several beats rather than being handed thousands of reads it has no budget to fetch.
const TAIL_LISTED_READS = 1_000;

// How one file lays out past where a reader has read to, for a box following a session still
// writing it. It is one page of the end of the prefix however long the file has run, so a beat
// costs the same over a session of ten stretches and one of ten thousand.
//
// Where a two-segment stretch sits in the archive is the sizes of the stretches in front of it, so
// a page that opens mid-file cannot place one on its own. The reader's cursor is what places it:
// a read is taken whole or not at all, so `from` is always the end of some stretch, and `after`
// names that stretch. The page starts past it and the first object in it opens at `from`. Both
// numbers come off the manifest the archive itself wrote, so neither is the reader's arithmetic.
//
// The cursor places the page in the file as well as in the archive, since a key can sort past it
// and still name a span the stretch it names already accounted for — an old host and a new one
// racing one append leave two keys over the same span, one of each form. Handing that one over
// would render a stretch the reader already has a second time and put the stretch behind it at the
// wrong place in the archive, so it is passed over the way the whole-file layout passes it over.
//
// A one-segment cursor is read on its own terms: the key names a place in the archive, so the page
// reaches one stretch back from the reader instead — no stretch holds more than MAX_STRETCH_BYTES,
// so a key below that floor cannot reach past the reader, and a stretch landing below a key the
// reader has already taken, which only that form's writers can do, is named however late it lands.
export const archivedSince = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  after: string,
): Promise<Run[]> => {
  const prefix = filePrefix(userId, sessionId, file);
  const named = after === "" ? null : namedStretch(after);
  const cursor = named !== null && named.form !== "place" ? named : null;
  const floor = cursor !== null ? 0 : Math.max(0, from - MAX_STRETCH_BYTES);
  const key = cursor !== null ? `${prefix}${after}` : `${prefix}${legacyStretchName(floor - 1)}`;
  const page = await bucket.list({
    prefix,
    limit: TAIL_LISTED_READS,
    ...(cursor !== null || floor > 0 ? { startAfter: key } : {}),
  });
  const listed: Listed[] = [];
  for (const object of page.objects) {
    const stretch = listedStretch(object.key.slice(prefix.length), object.size);
    if (stretch !== null) listed.push(stretch);
  }
  const opens: Opens = cursor === null ? FIRST_OBJECT : { archive: from, source: cursor.through };
  const kept: Run[] = [];
  let budget = TAIL_LISTED_READS;
  for (const run of runsOf(laidOut(listed, opens))) {
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

// One stretch, opened by the name it is stored under and ranged by what the caller asked for, or
// whole where it asked for no range — which is how a gzip member is read, since it has no part to
// ask for. Nothing is listed and nothing is parsed: a manifest already said which stretches a file
// holds, and this hands back the bytes of one of them.
export const openStretch = (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  name: string,
  range?: R2Range,
): Promise<R2ObjectBody | null> =>
  bucket.get(keyOf(userId, sessionId, file, name), range === undefined ? undefined : { range });

// One stretch as it is stored: the bytes of the object, and — where those are gzipped — how many
// bytes of the file they inflate to. Nothing reads that length off a gzip member, so the name
// carries it, and every reading of where the stretch sits in the archive rests on that number
// rather than on the object's own size.
export type StretchBody =
  | { kind: "plain"; bytes: ArrayBuffer }
  | { kind: "gzip"; bytes: ArrayBuffer; inflates: number };

const holdsOf = (body: StretchBody): number => (body.kind === "gzip" ? body.inflates : body.bytes.byteLength);

const nameOf = (from: number, through: number, body: StretchBody): string =>
  body.kind === "gzip" ? compressedStretchName(from, through, body.inflates) : stretchName(from, through);

const GZIP_MAGIC = 0x1f8b;

// How many bytes one gzip member inflates to, counted by inflating it. The length the format
// trails is no answer: it belongs to the last member of the body, so a body holding two of them
// would be stored under a name claiming part of what it holds, and every later read of that object
// would break for good. Nothing of the inflated bytes is kept — the member is what the archive
// stores — and a body inflating past what one stretch may hold is stopped here, as is one holding a
// second member, which the stream refuses outright.
const inflatedLength = async (body: ArrayBuffer): Promise<number> => {
  const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  let held = 0;
  for (;;) {
    const taken = await reader.read();
    if (taken.done) return held;
    held += taken.value.byteLength;
    if (held > MAX_STRETCH_BYTES) {
      await reader.cancel();
      throw new Error(`a gzipped transcript stretch must inflate to at most ${MAX_STRETCH_BYTES} bytes`);
    }
  }
};

// One appended body as the archive stores it. A gzip member goes up as it stands, so a reader is
// handed the member and inflates it, and the one number every placing of a stretch in the archive
// rests on is taken here and written into the name. A transcript stretch is prose and JSON and
// never opens with the two bytes gzip does, so the two forms tell themselves apart: a host that has
// yet to learn to compress one sends the bytes of the file and they are stored as they stand.
export const storedStretch = async (body: ArrayBuffer): Promise<StretchBody> => {
  if (body.byteLength < 2 || new DataView(body).getUint16(0) !== GZIP_MAGIC) {
    return { kind: "plain", bytes: body };
  }
  return { kind: "gzip", bytes: body, inflates: await inflatedLength(body) };
};

// The one write an append from a host before redaction makes, and it lands only where nothing is
// yet. Where the stretch begins in the archive is that caller's to say and the key carries it, so
// nothing is read first and nothing is claimed; a second writer reaching the same place is
// answered `false` and told how far the archive runs rather than writing over the first.
//
// A gzipped body is stored as the encoding it is, so a reader is handed the member and inflates it
// rather than being handed bytes the service inflated for it.
export const putStretch = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  name: string,
  body: StretchBody,
): Promise<boolean> => {
  const written = await bucket.put(keyOf(userId, sessionId, file, name), body.bytes, {
    httpMetadata: {
      contentType: "application/x-ndjson",
      ...(body.kind === "gzip" ? { contentEncoding: "gzip" } : {}),
    },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written !== null;
};

export type Appended =
  | {
      kind: "written";
      through: number;
      /// How many bytes of the file the archive holds once this stretch is in it, which is the
      /// count it held before plus what the stretch just stored accounts for. The reach the stretch
      /// was weighed against came off the same listing, so this costs no second one.
      archived: number;
    }
  | ({ kind: "refused" } & Extent);

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
//
// The one listing answers both questions the append has: how far into the file the archive reaches,
// which is what the stretch is weighed against, and how many bytes of the file it holds, which is
// what the index and a following box are weighed against. The second is written down here rather
// than counted again by the consumer the storage event wakes.
export const appendStretch = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  through: number,
  body: StretchBody,
): Promise<Appended> => {
  const parts = await stretches(bucket, userId, sessionId, file);
  const reach = extentOf(parts);
  if (reach.through !== from) return { kind: "refused", ...reach };
  const runs = runsOf(parts);
  // A key already there names this same span of the same file and says it accounts for the same
  // number of bytes, so the stretch is accounted for whichever writer put it there and the first to
  // land is the one kept. The count below comes off the name rather than off the body, so two
  // writers whose gzip left them bodies of different lengths still leave the same count behind.
  await putStretch(bucket, userId, sessionId, file, nameOf(from, through, body), body);
  return { kind: "written", through, archived: (runs[runs.length - 1]?.to ?? 0) + holdsOf(body) };
};

// The one thing worth keeping off the objects: how many bytes of a session's own transcript the
// archive holds. The indexer reads it on every pass and must not pay for a listing, and the append
// that moved it already paid for the listing that says it. It is folded in with MAX, so a write
// that lands behind one for a later stretch leaves the row where the objects already put it.
//
// A delegated turn derives nothing — the index never reads one — so its stretch writes no row at
// all. The archive answers for those files by listing them, which is the only reading that can
// answer without lagging.
export const cacheArchived = (
  db: D1Database,
  userId: string,
  sessionId: string,
  archived: number,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO session_index (user_id, session_id, archived, bytes, chunks) VALUES (?1, ?2, ?3, 0, 0)
       ON CONFLICT (user_id, session_id) DO UPDATE SET archived = MAX(session_index.archived, excluded.archived)`,
    )
    .bind(userId, sessionId, archived);

// How far into each of a session's files the archive reaches, counted off the objects and nothing
// else. Every caller that acts on the answer reads it here — a host working out where to send the
// rest of a file, a restore writing them back to disk, a writer told where it was beaten to a
// place — because a count a second behind would have one of them write over a stretch or stop
// short of one.
export const archivedFiles = async (bucket: R2Bucket, userId: string, sessionId: string): Promise<TranscriptFile[]> =>
  (await archivedTranscript(bucket, userId, sessionId)).map(
    ({ file, bytes, through, named }): TranscriptFile => ({ file, bytes, through, named }),
  );
