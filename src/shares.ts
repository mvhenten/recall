import { sha256Hex } from "./device";
import { fail, type Parsed } from "./model";

export const shareModes = ["link", "email"] as const;
export type ShareMode = (typeof shareModes)[number];

// The three bases every address on the artifact hostname is built from, and the two segments that
// answer under each of them. An artifact lives under ARTIFACT_PREFIX and its files under
// FILE_SEGMENT, so a name occupies no position a route occupies and a file path occupies none
// either: the guarantee is the addressing's, not the name grammar's.
export const ARTIFACT_PREFIX = "/a";
export const SHARE_LINK_PREFIX = "/link";
export const SHARE_EMAIL_PREFIX = "/email";
export const FILE_SEGMENT = "f";
export const PLAYER_SEGMENT = "player.js";

export const SHARE_DAYS = 30;
export const SHARE_WINDOW_MS = SHARE_DAYS * 86_400_000;

// Past this a share's expiry date reads the same as any other date, so the row prints the date
// alone and names the time left only once it is near.
export const SHARE_SOON_MS = 14 * 86_400_000;

export const MAX_EMAIL_SHARES = 20;

export const SHARE_ID_PREFIX = "sh_";

const MAX_ADDRESS_CHARS = 254;

const ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const ADDRESS_MESSAGE = `an address holds a name, an @ and a domain with a dot, and at most ${MAX_ADDRESS_CHARS} characters, like reader@example.com`;

// One row of `artifact_shares`. `subject` holds a link share's token hashed with SHA-256 and an
// email share's lower-cased address, and `mode` is what gives it its meaning; two columns, one of
// them always empty, is what this avoids.
export interface ShareRecord {
  shareId: string;
  userId: string;
  name: string;
  mode: ShareMode;
  subject: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
  uses: number;
}

// What crosses to a page. A link share carries no address field at all, so neither the dashboard
// nor the CLI can print one for it by accident, and the token's hash never crosses: it is a
// credential and there is nothing to show for it.
export type ShareView =
  | {
      mode: "link";
      shareId: string;
      name: string;
      createdAt: number;
      expiresAt: number;
      lastUsedAt: number;
      uses: number;
    }
  | {
      mode: "email";
      shareId: string;
      name: string;
      address: string;
      createdAt: number;
      expiresAt: number;
      lastUsedAt: number;
      uses: number;
    };

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

// The id names a share and proves nothing: it is the primary key, the segment in an email share's
// address and the id a revoke names. It is random rather than the artifact's name because two
// accounts publish the same name and a recipient must not be able to walk from one share to
// another.
export const newShareId = (): string => `${SHARE_ID_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;

// A link share's whole credential. Storage holds only its hash, so it is returned once by the
// request that mints it and is never readable again.
export const newShareToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const hashShareToken = (token: string): Promise<string> => sha256Hex(token);

export const parseShareAddress = (value: unknown): Parsed<string> => {
  if (typeof value !== "string") return fail(ADDRESS_MESSAGE);
  const address = value.trim().toLowerCase();
  if (address.length > MAX_ADDRESS_CHARS || !ADDRESS.test(address)) return fail(ADDRESS_MESSAGE);
  return { ok: true, value: address };
};

export const shareTimeLeft = (expiresAt: number, now: number): string => {
  const left = expiresAt - now;
  if (left > SHARE_SOON_MS || left <= 0) return "";
  const days = Math.floor(left / 86_400_000);
  if (days > 0) return `${days} ${days === 1 ? "day" : "days"} left`;
  const hours = Math.floor(left / 3_600_000);
  if (hours > 0) return `${hours} ${hours === 1 ? "hour" : "hours"} left`;
  const minutes = Math.max(1, Math.floor(left / 60_000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
};
