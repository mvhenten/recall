#!/usr/bin/env node
// Marks the generated zod integers as integers. The zod emitter writes a TypeSpec `int32` and a
// `float64` as the same bounded `z.number()`, so a limit of 3.5 would pass the contract's own
// schema; the OpenAPI the same compile emits does tell the two apart. This reads the integrality
// out of that file and rewrites the matching `z.number()` to `z.int()`, so the contract stays the
// only place the rule is written down.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const generated = join(dirname(fileURLToPath(import.meta.url)), "..", "typespec", "generated");
const schemas = JSON.parse(readFileSync(join(generated, "openapi.json"), "utf8")).components.schemas;

const resolved = (property) => {
  const ref = property.$ref;
  if (!ref) return property;
  const target = schemas[ref.slice(ref.lastIndexOf("/") + 1)];
  if (!target) throw new Error(`the OpenAPI names a schema it does not define: ${ref}`);
  return target;
};

const integerFields = (schema) =>
  Object.entries(schema.properties ?? {})
    .filter(([, property]) => resolved(property).type === "integer")
    .map(([field]) => field);

const file = join(generated, "schemas.ts");
const blocks = readFileSync(file, "utf8").split(/(?=^export const )/m);

const marked = blocks.map((block) => {
  const name = /^export const (\w+)Schema = /.exec(block)?.[1];
  const schema = name === undefined ? undefined : schemas[name];
  if (!schema) return block;
  return integerFields(schema).reduce((held, field) => {
    const whole = new RegExp(`(\\b${field}: z\\.)number\\(\\)`);
    if (!whole.test(held)) throw new Error(`no generated z.number() to mark whole: ${name}.${field}`);
    return held.replace(whole, "$1int()");
  }, block);
});

writeFileSync(file, marked.join(""));
