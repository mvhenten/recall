import "@typespec/json-schema";
import "@kattebak/typespec-zod-emitter";

using TypeSpec.JsonSchema;

@service(#{ title: "recall" })
@jsonSchema
namespace Recall;

enum Speaker {
  User,
  Model,
  Machinery,
}

model TranscriptRecord {
  ordinal: int32;
  recordId: string;
  line: string;
}

model AppendRecords {
  file: string;
  from: int64;
  records: TranscriptRecord[];
}

model RecordsAccepted {
  file: string;
  next: int64;
}

model FileReach {
  file: string;
  bytes: int64;
}
