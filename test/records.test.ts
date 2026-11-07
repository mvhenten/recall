import { describe, expect, it } from "vitest";
import { AppendRecordsSchema } from "../typespec/generated/schemas";
import record from "./fixtures/redacted-record.json";

// The generated validator, put to the shape a host actually sends: a verbatim redacted transcript
// line, carried by the record that names where it sits. A property TypeSpec declared required has
// to be required here too, or the Worker boundary would take a body the models say cannot exist.

describe("the generated append body", () => {
  it("accepts a redacted transcript line", () => {
    const body = { file: "main", from: 0, records: [record] };
    expect(AppendRecordsSchema.parse(body)).toEqual(body);
  });

  it("rejects a record with no recordId", () => {
    const body = { file: "main", from: 0, records: [{ ordinal: record.ordinal, line: record.line }] };
    expect(AppendRecordsSchema.safeParse(body).success).toBe(false);
  });
});
