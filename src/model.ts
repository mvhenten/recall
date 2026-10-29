import { z } from "zod";

export const memoryTypes = ["user", "feedback", "project", "reference"] as const;

export const nameSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be a kebab-case slug");

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/, "tag may hold lower-case letters, digits and . _ : / -");

export const tagsSchema = z
  .array(tagSchema)
  .max(50)
  .transform((tags) => [...new Set(tags)].sort());

export const saveSchema = z.object({
  description: z.string().min(1).max(500),
  type: z.enum(memoryTypes),
  body: z.string().max(100_000),
  tags: tagsSchema,
});

export const searchSchema = z
  .object({
    query: z.string().min(1).max(2_000),
    tags: tagsSchema,
    any: z.boolean(),
    limit: z.number().int().min(1).max(50),
    minScore: z.number().min(-1).max(1),
  })
  .refine((input) => input.any !== input.tags.length > 0, {
    message: "pass at least one tag, or any: true with no tags to match every memory",
    path: ["tags"],
  });

export const listSchema = z.object({
  tag: z.array(tagSchema),
  since: z.coerce.number().int().min(0),
  cursor: z.string(),
  limit: z.coerce.number().int().min(1).max(100),
});

export type MemoryType = (typeof memoryTypes)[number];
export type SaveInput = z.infer<typeof saveSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
export type ListInput = z.infer<typeof listSchema>;

export interface Memory {
  memoryId: string;
  userId: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  recallCount: number;
  lastRecalledAt: number;
}

export interface SearchHit {
  memory: Memory;
  score: number;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorIndex {
  upsert(namespace: string, id: string, values: number[]): Promise<void>;
  query(namespace: string, values: number[], topK: number): Promise<VectorMatch[]>;
  remove(ids: string[]): Promise<void>;
}

export type Verification = { ok: true; clientId: string } | { ok: false; reason: string };

export type Verify = (assertion: string) => Promise<Verification>;
