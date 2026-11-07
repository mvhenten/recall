// How the archive's legacy objects become the form v0.18.0 writes: the plan read off one listing of
// the bucket, and the conversion of one stretch under it. The bucket is handed in, so the plan and
// the conversion are exercised over a bucket held in memory and the live archive is reached only by
// recompress-archive.mjs.
//
// A stretch is stored under `<user>/<session>/<file>/<name>`, and the name is one of three forms: one
// offset, a span of the file, or a span and how many bytes the gzip member inflates to. The first two
// hold the bytes of the file as they stand, so what each accounts for is its own size; the third is a
// gzip member and its name carries that length, since nothing reads it off the object. Converting one
// therefore keeps the span it already had and names its own size as what it inflates to, which leaves
// every stretch of the file sitting exactly where in the archive it sat before.
//
// Nothing here redacts. These bytes were archived before client-side redaction existed and they go
// back up as they came down.
import { gunzipSync, gzipSync } from "node:zlib";

// Mirrors src/transcript-plan.ts, which the Worker bundles and node cannot load. The archive's key
// forms are the contract between the two.
const OFFSET_DIGITS = 16;

const STRETCH_NAME = new RegExp(
  `^([0-9]{${OFFSET_DIGITS}})(?:\\.([0-9]{${OFFSET_DIGITS}})(?:\\.([0-9]{${OFFSET_DIGITS}}))?)?$`,
);

const padded = (place) => String(place).padStart(OFFSET_DIGITS, "0");

export const compressedStretchName = (from, through, inflates) =>
  `${padded(from)}.${padded(through)}.${padded(inflates)}`;

export const namedStretch = (name) => {
  const found = STRETCH_NAME.exec(name);
  const opens = found?.[1];
  if (opens === undefined) return null;
  const from = Number(opens);
  const ends = found?.[2];
  if (ends === undefined) return { form: "place", from };
  const through = Number(ends);
  const inflates = found?.[3];
  if (inflates === undefined) return { form: "span", from, through };
  return { form: "packed", from, through, inflates: Number(inflates) };
};

// Mirrors MAX_STRETCH_BYTES in src/transcripts.ts: how much of a file one stretch may account for.
// An append inflates a member to take its name's third segment and refuses one past this, so a
// legacy object larger than it cannot be rewritten in the compressed form at all.
export const MAX_STRETCH_BYTES = 1_048_576;

const stretchKey = (key) => {
  const [userId, sessionId, file, name, ...rest] = key.split("/");
  if (rest.length > 0) return null;
  if (!userId || !sessionId || !file || !name) return null;
  const named = namedStretch(name);
  return named === null ? null : { session: `${userId}/${sessionId}`, file, name, named };
};

// The span of the file one object accounts for and how many of that file's bytes it holds. A stretch
// stored as it stands holds its own size; a gzip member holds what its name says it inflates to.
const spanOf = (named, size) => {
  if (named.form === "place") return { from: named.from, through: named.from + size, holds: size };
  if (named.form === "span") return { from: named.from, through: named.through, holds: size };
  return { from: named.from, through: named.through, holds: named.inflates };
};

const nameOf = (span) => span.legacy?.name ?? compressedStretchName(span.from, span.through, span.holds);

// Why one file is no candidate for conversion. Where a stretch sits in the archive is read two ways:
// a one-offset name is a place in the archive outright, and a span is placed by the lengths of the
// stretches in front of it. The two agree only where the file's stretches meet exactly, from its
// first byte, each opening where the one before it ended. A file that does not lay out that way —
// stretches that overlap, or a run of bytes no object holds — would be placed differently once its
// objects carried spans, so it is left alone and named instead.
const refusalOf = (file, spans) => {
  const reasons = [];
  let at = 0;
  for (const span of spans) {
    if (span.conflict !== undefined) reasons.push(`${file}: ${span.conflict}`);
    else if (span.from !== at) {
      reasons.push(`${file}: ${nameOf(span)} opens at ${span.from} where the file is accounted for through ${at}`);
    } else if (span.legacy !== null && span.holds > MAX_STRETCH_BYTES) {
      reasons.push(`${file}: ${nameOf(span)} holds ${span.holds} bytes, past the ${MAX_STRETCH_BYTES} a stretch may`);
    }
    at = span.through;
  }
  return reasons;
};

// What the bucket holds and what of it is to be converted, off one listing and nothing else. A
// session every object of which is named in the compressed form has no entry under `sessions` and is
// done; one whose files do not lay out cleanly is named under `left` and nothing of it is touched.
export const archivePlan = (objects) => {
  const byFile = new Map();
  const held = {
    objects: 0,
    bytes: 0,
    legacy: { objects: 0, bytes: 0 },
    packed: { objects: 0, bytes: 0, inflates: 0 },
  };
  const strays = [];
  for (const { key, size } of objects) {
    const found = stretchKey(key);
    if (found === null) {
      strays.push(key);
      continue;
    }
    held.objects += 1;
    held.bytes += size;
    const packed = found.named.form === "packed";
    const counted = packed ? held.packed : held.legacy;
    counted.objects += 1;
    counted.bytes += size;
    if (packed) held.packed.inflates += found.named.inflates;
    const id = `${found.session}/${found.file}`;
    const file =
      byFile.get(id) ??
      byFile.set(id, { session: found.session, file: found.file, prefix: `${id}/`, spans: new Map() }).get(id);
    const { from, through, holds } = spanOf(found.named, size);
    const at = `${from}.${through}`;
    const span = file.spans.get(at);
    if (span === undefined) {
      file.spans.set(at, { from, through, holds, packed, legacy: packed ? null : { name: found.name, size } });
      continue;
    }
    // An interrupted run leaves a legacy object beside the member written from it. The two say the
    // same span and the same length, so the member is kept and the legacy object is removed once it
    // has been verified against — the same work the conversion does, minus the write.
    if (span.holds !== holds) {
      span.conflict = `${found.name} holds ${holds} bytes where ${nameOf(span)} says ${span.holds} over the same span`;
    }
    if (packed) span.packed = true;
    else span.legacy = { name: found.name, size };
  }

  const bySession = new Map();
  for (const file of byFile.values()) {
    const session =
      bySession.get(file.session) ??
      bySession
        .set(file.session, { session: file.session, objects: 0, bytes: 0, files: [], reasons: [] })
        .get(file.session);
    const spans = [...file.spans.values()].sort((left, right) => left.from - right.from);
    session.reasons.push(...refusalOf(file.file, spans));
    const convert = spans.filter((span) => span.legacy !== null);
    if (convert.length === 0) continue;
    session.objects += convert.length;
    session.bytes += convert.reduce((all, span) => all + span.legacy.size, 0);
    session.files.push({ file: file.file, prefix: file.prefix, convert });
  }
  const ordered = [...bySession.values()].sort((left, right) => (left.session < right.session ? -1 : 1));
  return {
    ...held,
    strays,
    sessions: ordered.filter((session) => session.reasons.length === 0 && session.files.length > 0),
    left: ordered.filter((session) => session.reasons.length > 0),
  };
};

const same = (left, right) => left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;

// What an object holds, read as the file's own bytes. A transport that inflates a gzipped object on
// the way down hands those back outright; one that does not hands back the member. Bytes that are
// neither are no member of anything, and the caller names the key they came from.
const fileBytes = (back, original) => {
  if (same(back, original)) return back;
  try {
    return gunzipSync(back);
  } catch {
    return null;
  }
};

// One stretch read, gzipped, written under the name that says what it inflates to, and read back and
// compared against the bytes it came from before the legacy object is removed. The read back is the
// whole of the proof: a transport that inflates a gzipped object on the way down hands back the file's
// own bytes, and one that does not hands back the member, so either the bytes match outright or they
// match once inflated. Anything else leaves both objects where they are and stops.
const rekeyStretch = async (bucket, session, prefix, span) => {
  const legacyKey = `${prefix}${span.legacy.name}`;
  const original = await bucket.get(legacyKey);
  if (original === null) throw new Error(`${session}: the archive lost ${legacyKey}`);
  if (original.byteLength !== span.legacy.size) {
    throw new Error(
      `${session}: ${legacyKey} holds ${original.byteLength} bytes where the listing said ${span.legacy.size}`,
    );
  }
  const key = `${prefix}${compressedStretchName(span.from, span.through, original.byteLength)}`;
  const member = gzipSync(original, { level: 9 });
  await bucket.put(key, member);
  const back = await bucket.get(key);
  if (back === null) throw new Error(`${session}: ${key} is not there after being written`);
  const plain = fileBytes(back, original);
  if (plain === null || !same(plain, original)) {
    throw new Error(`${session}: ${key} does not hold the bytes of ${legacyKey}; both are left as they are`);
  }
  await bucket.delete(legacyKey);
  return { was: original.byteLength, now: member.byteLength };
};

// One session converted whole, its files in order and each file's stretches in the order the file
// puts them. An interruption therefore leaves a session's earlier stretches converted and its later
// ones legacy, which the next run reads off the listing and carries on from.
export const rekeySession = async (bucket, session) => {
  const held = { objects: 0, was: 0, now: 0 };
  for (const file of session.files) {
    for (const span of file.convert) {
      const stretch = await rekeyStretch(bucket, session.session, file.prefix, span);
      held.objects += 1;
      held.was += stretch.was;
      held.now += stretch.now;
    }
  }
  return held;
};

export const size = (bytes) => {
  for (const [unit, scale] of [
    ["GB", 1e9],
    ["MB", 1e6],
    ["kB", 1e3],
  ]) {
    if (bytes >= scale) return `${(bytes / scale).toFixed(2)} ${unit}`;
  }
  return `${bytes} B`;
};

const reportPlan = (plan, say) => {
  say(`the archive holds ${plan.objects} stretches, ${size(plan.bytes)}`);
  say(`${plan.legacy.objects} of them are in the legacy forms, ${size(plan.legacy.bytes)}`);
  say(`${plan.packed.objects} are already gzipped, ${size(plan.packed.bytes)} holding ${size(plan.packed.inflates)}`);
  if (plan.packed.bytes > 0) {
    const ratio = plan.packed.inflates / plan.packed.bytes;
    say(
      `what is already gzipped inflates ${ratio.toFixed(2)}x, so the legacy ${size(plan.legacy.bytes)} should land near ${size(plan.legacy.bytes / ratio)}`,
    );
  }
  if (plan.strays.length > 0) say(`${plan.strays.length} keys are no stretch of any file and are left alone`);
  for (const session of plan.sessions) {
    say(
      `${session.session}: ${session.objects} stretches, ${size(session.bytes)}, in ${session.files.map((file) => file.file).join(", ")}`,
    );
  }
  for (const session of plan.left) {
    for (const reason of session.reasons) say(`left alone: ${session.session} ${reason}`);
  }
};

// The whole run: one listing, the plan reported, and — only when told to — each session converted in
// turn. A dry run opens no object and writes nothing.
export const rekeyArchive = async (bucket, { apply, say }) => {
  const plan = archivePlan(await bucket.list(""));
  reportPlan(plan, say);
  if (!apply) {
    say("dry run; nothing was read or written. pass --apply to convert");
    return plan;
  }
  const total = { objects: 0, was: 0, now: 0 };
  for (const session of plan.sessions) {
    const held = await rekeySession(bucket, session);
    total.objects += held.objects;
    total.was += held.was;
    total.now += held.now;
    say(`${session.session}: ${held.objects} stretches, ${size(held.was)} is now ${size(held.now)}`);
  }
  say(`converted ${total.objects} stretches, ${size(total.was)} is now ${size(total.now)}`);
  return plan;
};
