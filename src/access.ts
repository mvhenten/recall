import { type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Verification, Verify } from "./model";

export const accessVerifier =
  (keys: JWTVerifyGetKey, issuer: string, audience: string): Verify =>
  async (assertion: string): Promise<Verification> => {
    const verified = await jwtVerify(assertion, keys, { issuer, audience, algorithms: ["RS256"] }).then(
      (result) => ({ ok: true as const, payload: result.payload }),
      (error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }),
    );
    if (!verified.ok) return verified;
    const clientId = verified.payload.common_name;
    if (typeof clientId !== "string" || clientId === "") {
      return {
        ok: false,
        reason: "the token carries no service token common_name; only service tokens may call recall",
      };
    }
    return { ok: true, clientId };
  };
