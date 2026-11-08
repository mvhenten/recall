import { describe, expect, it } from "vitest";
import { AppendRecordsSchema } from "../typespec/generated/schemas";
import record from "./fixtures/redacted-record.json";

describe("the generated append body", () => {
  it("accepts a redacted transcript line", () => {
    const body = { file: "main", from: 0, records: [record.line], closed: true };
    expect(AppendRecordsSchema.parse(body)).toEqual(body);
  });

  it("rejects an ordinal before the start of the file", () => {
    const body = { file: "main", from: -5, records: [record.line], closed: true };
    expect(AppendRecordsSchema.safeParse(body).success).toBe(false);
  });

  it("rejects a batch over the record limit", () => {
    const body = { file: "main", from: 0, records: Array(1001).fill(record.line), closed: true };
    expect(AppendRecordsSchema.safeParse(body).success).toBe(false);
  });

  it("rejects an append that does not say whether a break closes its last record", () => {
    const body = { file: "main", from: 0, records: [record.line] };
    expect(AppendRecordsSchema.safeParse(body).success).toBe(false);
  });
});
