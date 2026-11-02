// What a session is working on, written without a model call: its first prompt and its latest.
// `recall sessions` joins the two into the focus line it prints.
export const FOCUS_PART_CHARS = 72;

export function condense(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

export function truncate(text, max = FOCUS_PART_CHARS) {
  const line = condense(text);
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}
