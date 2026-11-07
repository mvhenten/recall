import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { archivePlan, compressedStretchName, rekeyArchive } from "./stretch-rekey.mjs";

const SESSION = "alice/0199-abc";

const lines = (seed, count) =>
  Buffer.from(
    Array.from({ length: count }, (_, line) => `{"seed":"${seed}","line":${line},"text":"a transcript line"}\n`).join(
      "",
    ),
  );

const wrecked = (body) => {
  const copy = Buffer.from(body);
  copy[Math.floor(copy.byteLength / 2)] ^= 0xff;
  return copy;
};

// A bucket held in memory, listing and reading and writing the way the S3 client over the live
// archive does. `wreck` flips a byte of one named key's body on its way in, and `breakAfter` stops
// the run part way through the way an interrupted pass does.
const fakeBucket = ({ wreck = null, breakAfter = Number.POSITIVE_INFINITY } = {}) => {
  const held = new Map();
  const wrote = [];
  let puts = 0;
  return {
    held,
    wrote,
    put: async (key, body) => {
      if (puts >= breakAfter) throw new Error("interrupted");
      puts += 1;
      wrote.push(`put ${key}`);
      held.set(key, key === wreck ? wrecked(body) : body);
    },
    get: async (key) => held.get(key) ?? null,
    delete: async (key) => {
      wrote.push(`delete ${key}`);
      held.delete(key);
    },
    list: async (prefix) =>
      [...held]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, size: body.byteLength }))
        .sort((left, right) => (left.key < right.key ? -1 : 1)),
  };
};

const padded = (place) => String(place).padStart(16, "0");

// A file's worth of legacy objects in the two-segment form, laid end to end from its first byte.
const legacySpans = (bucket, file, bodies) => {
  let at = 0;
  const original = new Map();
  for (const body of bodies) {
    const key = `${SESSION}/${file}/${padded(at)}.${padded(at + body.byteLength)}`;
    bucket.held.set(key, body);
    original.set(`${SESSION}/${file}/${compressedStretchName(at, at + body.byteLength, body.byteLength)}`, body);
    at += body.byteLength;
  }
  return original;
};

const quiet = () => {};

test("a session of legacy objects converts, and each new key names what it inflates to", async () => {
  const bucket = fakeBucket();
  const wanted = legacySpans(bucket, "main", [lines("a", 40), lines("b", 60), lines("c", 20)]);

  await rekeyArchive(bucket, { apply: true, say: quiet });

  assert.deepEqual([...bucket.held.keys()].sort(), [...wanted.keys()].sort());
  for (const [key, body] of wanted) {
    const member = bucket.held.get(key);
    assert.ok(member.byteLength < body.byteLength, `${key} is smaller than what it holds`);
    assert.deepEqual(gunzipSync(member), body);
    assert.equal(Number(key.split("/").pop().split(".")[2]), body.byteLength);
  }
});

test("a one-segment key ends where its own bytes end", async () => {
  const bucket = fakeBucket();
  const first = lines("a", 30);
  const second = lines("b", 30);
  bucket.held.set(`${SESSION}/main/${padded(0)}`, first);
  bucket.held.set(`${SESSION}/main/${padded(first.byteLength)}`, second);

  await rekeyArchive(bucket, { apply: true, say: quiet });

  assert.deepEqual(
    [...bucket.held.keys()].sort(),
    [
      `${SESSION}/main/${compressedStretchName(0, first.byteLength, first.byteLength)}`,
      `${SESSION}/main/${compressedStretchName(first.byteLength, first.byteLength + second.byteLength, second.byteLength)}`,
    ].sort(),
  );
  assert.deepEqual(gunzipSync(bucket.held.get([...bucket.held.keys()].sort()[0])), first);
});

test("a dry run reads nothing and writes nothing", async () => {
  const bucket = fakeBucket();
  const wanted = legacySpans(bucket, "main", [lines("a", 40), lines("b", 10)]);
  const before = [...bucket.held.keys()].sort();

  const plan = await rekeyArchive(bucket, { apply: false, say: quiet });

  assert.deepEqual([...bucket.held.keys()].sort(), before);
  assert.deepEqual(bucket.wrote, []);
  assert.equal(plan.legacy.objects, 2);
  assert.equal(plan.packed.objects, 0);
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.sessions[0].objects, wanted.size);
});

test("running it again converts nothing", async () => {
  const bucket = fakeBucket();
  legacySpans(bucket, "main", [lines("a", 40), lines("b", 10)]);
  await rekeyArchive(bucket, { apply: true, say: quiet });
  const converted = [...bucket.held.keys()].sort();
  bucket.wrote.length = 0;

  const plan = await rekeyArchive(bucket, { apply: true, say: quiet });

  assert.deepEqual([...bucket.held.keys()].sort(), converted);
  assert.deepEqual(bucket.wrote, []);
  assert.deepEqual(plan.sessions, []);
  assert.deepEqual(plan.left, []);
  assert.equal(plan.legacy.objects, 0);
});

test("an interrupted run resumes where it stopped", async () => {
  const bodies = [lines("a", 40), lines("b", 60), lines("c", 20), lines("d", 15)];
  const stopped = fakeBucket({ breakAfter: 2 });
  const wanted = legacySpans(stopped, "main", bodies);

  await assert.rejects(rekeyArchive(stopped, { apply: true, say: quiet }), /interrupted/);
  const half = [...stopped.held.keys()];
  assert.equal(half.filter((key) => key.split("/").pop().split(".").length === 3).length, 2);
  assert.equal(half.filter((key) => key.split("/").pop().split(".").length === 2).length, 2);

  const carried = fakeBucket();
  for (const [key, body] of stopped.held) carried.held.set(key, body);
  await rekeyArchive(carried, { apply: true, say: quiet });

  assert.deepEqual([...carried.held.keys()].sort(), [...wanted.keys()].sort());
  for (const [key, body] of wanted) assert.deepEqual(gunzipSync(carried.held.get(key)), body);
});

test("a legacy object left beside the member written from it is removed on the next run", async () => {
  const bucket = fakeBucket();
  const body = lines("a", 40);
  const legacyKey = `${SESSION}/main/${padded(0)}.${padded(body.byteLength)}`;
  legacySpans(bucket, "main", [body]);
  await rekeyArchive(bucket, { apply: true, say: quiet });
  const converted = [...bucket.held.keys()].sort();
  bucket.held.set(legacyKey, body);

  const plan = await rekeyArchive(bucket, { apply: true, say: quiet });

  assert.deepEqual(plan.left, []);
  assert.deepEqual([...bucket.held.keys()].sort(), converted);
});

test("a write that does not read back leaves both keys and stops on that session", async () => {
  const bodies = [lines("a", 40), lines("b", 60)];
  const named = [...legacySpans(fakeBucket(), "main", bodies).keys()];
  const broken = named[1];
  const bucket = fakeBucket({ wreck: broken });
  legacySpans(bucket, "main", bodies);
  const legacyKey = `${SESSION}/main/${padded(bodies[0].byteLength)}.${padded(bodies[0].byteLength + bodies[1].byteLength)}`;

  await assert.rejects(
    rekeyArchive(bucket, { apply: true, say: quiet }),
    (error) => error.message.includes(SESSION) && error.message.includes(broken),
  );

  assert.ok(bucket.held.has(broken), "the object that does not read back is left in place");
  assert.ok(bucket.held.has(legacyKey), "the object it was written from is left in place");
  assert.deepEqual(
    bucket.wrote.filter((entry) => entry === `delete ${legacyKey}`),
    [],
  );
});

test("a file with a hole in it is left alone and named", async () => {
  const bucket = fakeBucket();
  const first = lines("a", 30);
  const second = lines("b", 30);
  bucket.held.set(`${SESSION}/main/${padded(0)}.${padded(first.byteLength)}`, first);
  const past = first.byteLength + 500;
  bucket.held.set(`${SESSION}/main/${padded(past)}.${padded(past + second.byteLength)}`, second);
  const before = [...bucket.held.keys()].sort();

  const plan = await rekeyArchive(bucket, { apply: true, say: quiet });

  assert.deepEqual([...bucket.held.keys()].sort(), before);
  assert.deepEqual(plan.sessions, []);
  assert.equal(plan.left.length, 1);
  assert.match(plan.left[0].reasons[0], /main: .* opens at \d+ where the file is accounted for through \d+/);
});

test("a key the archive never wrote is no stretch of any file", () => {
  const plan = archivePlan([
    { key: `${SESSION}/main/${padded(0)}.${padded(10)}`, size: 10 },
    { key: `${SESSION}/main/notes.txt`, size: 4 },
    { key: "stray", size: 1 },
  ]);

  assert.deepEqual(plan.strays, [`${SESSION}/main/notes.txt`, "stray"]);
  assert.equal(plan.objects, 1);
});
