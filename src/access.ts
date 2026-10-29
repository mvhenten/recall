import { errors, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Verification, Verify } from "./model";

const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

const isTokenError = (error: unknown): error is Error => TOKEN_ERRORS.some((tokenError) => error instanceof tokenError);

export const accessVerifier =
  (keys: JWTVerifyGetKey, issuer: string, audience: string): Verify =>
  async (assertion: string): Promise<Verification> => {
    const verified = await jwtVerify(assertion, keys, { issuer, audience, algorithms: ["RS256"] }).then(
      (result) => ({ ok: true as const, payload: result.payload }),
      (error: unknown) => {
        if (!isTokenError(error)) throw error;
        return { ok: false as const, reason: error.message };
      },
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
