export const DIMENSIONS = 384;
const RRF_K = 60;

export const normalize = (vector: ArrayLike<number>): Float32Array => {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
};

// A stored embedding is its f32 scale (little endian) followed by one i8 per
// dimension, a quarter of the f32 size, which keeps search inside the CPU budget.
export const quantize = (vector: Float32Array): Uint8Array => {
  let peak = 0;
  for (const value of vector) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? peak / 127 : 1;
  const bytes = new Uint8Array(4 + vector.length);
  new DataView(bytes.buffer).setFloat32(0, scale, true);
  const values = new Int8Array(bytes.buffer, 4);
  for (let i = 0; i < vector.length; i++)
    values[i] = Math.max(-127, Math.min(127, Math.round((vector[i] ?? 0) / scale)));
  return bytes;
};

export const dot = (query: Float32Array, stored: Uint8Array): number => {
  if (stored.length !== query.length + 4) throw new Error(`stored embedding holds ${stored.length} bytes`);
  const scale = new DataView(stored.buffer, stored.byteOffset, 4).getFloat32(0, true);
  const values = new Int8Array(stored.buffer, stored.byteOffset + 4, query.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += (values[i] ?? 0) * (query[i] ?? 0);
  return sum * scale;
};

export const ftsQuery = (query: string): string | null => {
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((term) => term !== "").sort();
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" OR ");
};

export const reciprocalRankFusion = (rankings: string[][]): Array<[string, number]> => {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
