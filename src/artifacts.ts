export interface Artifact {
  name: string;
  bytes: number;
  updatedAt: number;
}

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export const ARTIFACT_CONTENT_TYPE = "text/html; charset=utf-8";

const keyFor = (userId: string, name: string): string => `${userId}/${name}`;

const toArtifact = (userId: string, object: R2Object): Artifact => ({
  name: object.key.slice(userId.length + 1),
  bytes: object.size,
  updatedAt: object.uploaded.getTime(),
});

export const readArtifact = (bucket: R2Bucket, userId: string, name: string): Promise<R2ObjectBody | null> =>
  bucket.get(keyFor(userId, name));

export const listArtifacts = async (bucket: R2Bucket, userId: string): Promise<Artifact[]> => {
  const prefix = `${userId}/`;
  const artifacts: Artifact[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor });
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
): Promise<Artifact> => {
  const object = await bucket.put(keyFor(userId, name), body);
  if (object === null) throw new Error(`R2 stored no page at ${keyFor(userId, name)}`);
  return toArtifact(userId, object);
};

export const deleteArtifact = (bucket: R2Bucket, userId: string, name: string): Promise<void> =>
  bucket.delete(keyFor(userId, name));
