// Published pages live in R2 under <user id>/<name>, never in D1: a page is a document, and the
// database holds records. The user id and the name are both slugs, so a key names one page of one
// user and nothing else. Both timestamps are the Worker's own clock, carried in object metadata,
// so a listing reads the same times the write answered with.

export interface Artifact {
  name: string;
  bytes: number;
  createdAt: number;
  updatedAt: number;
}

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export const ARTIFACT_CONTENT_TYPE = "text/html; charset=utf-8";

const keyFor = (userId: string, name: string): string => `${userId}/${name}`;

const stamp = (object: R2Object, field: "createdAt" | "updatedAt"): number => {
  const stored = Number(object.customMetadata?.[field]);
  return Number.isFinite(stored) && stored > 0 ? stored : object.uploaded.getTime();
};

const toArtifact = (userId: string, object: R2Object): Artifact => ({
  name: object.key.slice(userId.length + 1),
  bytes: object.size,
  createdAt: stamp(object, "createdAt"),
  updatedAt: stamp(object, "updatedAt"),
});

export const readArtifact = (bucket: R2Bucket, userId: string, name: string): Promise<R2ObjectBody | null> =>
  bucket.get(keyFor(userId, name));

export const listArtifacts = async (bucket: R2Bucket, userId: string): Promise<Artifact[]> => {
  const prefix = `${userId}/`;
  const artifacts: Artifact[] = [];
  let cursor: string | undefined;
  for (;;) {
    // A listing leaves custom metadata out unless it is asked for, and the timestamps live there.
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    artifacts.push(...page.objects.map((object) => toArtifact(userId, object)));
    if (!page.truncated) {
      return artifacts.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
    }
    cursor = page.cursor;
  }
};

export const putArtifact = async (
  bucket: R2Bucket,
  userId: string,
  name: string,
  body: ArrayBuffer,
  now: number,
): Promise<{ artifact: Artifact; created: boolean }> => {
  const key = keyFor(userId, name);
  const existing = await bucket.head(key);
  const createdAt = existing === null ? now : stamp(existing, "createdAt");
  await bucket.put(key, body, {
    httpMetadata: { contentType: ARTIFACT_CONTENT_TYPE },
    customMetadata: { createdAt: String(createdAt), updatedAt: String(now) },
  });
  return { artifact: { name, bytes: body.byteLength, createdAt, updatedAt: now }, created: existing === null };
};

export const deleteArtifact = async (bucket: R2Bucket, userId: string, name: string): Promise<boolean> => {
  const key = keyFor(userId, name);
  if ((await bucket.head(key)) === null) return false;
  await bucket.delete(key);
  return true;
};
