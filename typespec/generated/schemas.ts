import { z } from "zod";

export const SpeakerSchema = z.enum(["User", "Model", "Machinery"]);

export const TranscriptRecordSchema = z.object({
  ordinal: z.number(),
  recordId: z.string(),
  line: z.string(),
});

export const AppendRecordsSchema = z.object({
  file: z.string(),
  from: z.number(),
  records: z.array(TranscriptRecordSchema),
});

export const RecordsAcceptedSchema = z.object({
  file: z.string(),
  next: z.number(),
});

export const FileReachSchema = z.object({
  file: z.string(),
  bytes: z.number(),
});
