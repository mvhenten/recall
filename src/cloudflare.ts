import type { Embedder, VectorIndex, VectorMatch } from "./model";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

export const workersAiEmbedder = (ai: Ai): Embedder => ({
  async embed(text: string): Promise<number[]> {
    const output = await ai.run(EMBEDDING_MODEL, { text: [text] });
    if (!("data" in output) || !output.data?.[0]) throw new Error(`${EMBEDDING_MODEL} returned no embedding`);
    return output.data[0];
  },
});

export const vectorizeIndex = (index: Vectorize): VectorIndex => ({
  async upsert(namespace: string, id: string, values: number[]): Promise<void> {
    await index.upsert([{ id, values, namespace }]);
  },
  async query(namespace: string, values: number[], topK: number): Promise<VectorMatch[]> {
    const result = await index.query(values, { topK, namespace, returnValues: false, returnMetadata: "none" });
    return result.matches.map((match) => ({ id: match.id, score: match.score }));
  },
  async remove(ids: string[]): Promise<void> {
    await index.deleteByIds(ids);
  },
});
