// Where a deployment is and what reaches it, read exactly the way `cli/src/config.rs` reads it:
// the environment first, then the file `recall login` writes. Keeping the two readings the same is
// what lets an operator script run against the host they are already signed in on.
//
// A token is returned to the caller and never printed, and nothing here puts one on a command
// line.

export const parseEnv = (text) =>
  new Map(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => (line.startsWith("export ") ? line.slice("export ".length) : line))
      .map((line) => {
        const at = line.indexOf("=");
        if (at === -1) return null;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        const quote = value.startsWith('"') && value.endsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
        const unquoted = quote !== "" && value.length > 1 && value.endsWith(quote) ? value.slice(1, -1) : value;
        return [key, unquoted];
      })
      .filter((pair) => pair !== null),
  );

export const envFilePath = (env) => {
  if (env.RECALL_ENV_FILE) return env.RECALL_ENV_FILE;
  const home = env.XDG_CONFIG_HOME || (env.HOME ? `${env.HOME}/.config` : "");
  return home === "" ? "" : `${home}/recall/env`;
};

// What the two readings agree on. An empty value counts as absent on both sides, which is what
// `recall logout` leaves behind.
export const recallConfig = (env, text) => {
  const file = parseEnv(text);
  const value = (key) => env[key] || file.get(key) || "";
  return { endpoint: value("RECALL_ENDPOINT").replace(/\/+$/, ""), token: value("RECALL_TOKEN") };
};
