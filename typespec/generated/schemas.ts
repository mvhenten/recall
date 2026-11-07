import { z } from "zod";

export const AppendRecordsSchema = z.object({
  file: z.string().min(1),
  from: z.number().min(0),
  records: z.array(z.string().min(1)).max(1000),
});

export const RecordsAcceptedSchema = z.object({
  file: z.string().min(1),
  next: z.number().min(0),
});
