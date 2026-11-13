import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// The embedder crosses to the object as a function, so RPC hands the object a capability back into
// the Worker's request and keeps that session open for as long as the object holds it. This calls
// the object the way the Worker does and watches the Worker's own function come back.
it("gives the embedder back when the call is answered", async () => {
  let disposals = 0;
  const embed = Object.assign(
    async (texts: string[]): Promise<Float32Array[]> => texts.map(() => new Float32Array(8)),
    {
      [Symbol.dispose]: (): void => {
        disposals += 1;
      },
    },
  );
  const userId = "embedder-handed-back";

  await env.TENANT.get(env.TENANT.idFromName(userId)).tool(
    { name: "recall_list", arguments: {} },
    { userId, deviceId: "device-1", name: "laptop", host: "laptop" },
    { now: 1_700_000_000_000, embed, artifacts: null },
  );

  expect(disposals).toBe(1);
});
