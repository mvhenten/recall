// The service names a memory by a kebab-case slug of at most 100 characters (parseName in
// src/model.ts), so the file name goes through this before it reaches `recall save`.
const MAX_NAME_LENGTH = 100;

export function memoryName(file) {
  const stem = (file.split(/[/\\]/).pop() ?? "").replace(/\.md$/i, "");
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, "");
}
