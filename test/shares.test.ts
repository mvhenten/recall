import { describe, expect, it } from "vitest";
import {
  hashShareToken,
  newShareId,
  newShareToken,
  parseShareAddress,
  SHARE_ID_PREFIX,
  SHARE_SOON_MS,
  shareTimeLeft,
} from "../src/shares";

const DAY = 86_400_000;

describe("a link share's token", () => {
  it("carries 32 random bytes and never repeats", () => {
    const minted = Array.from({ length: 50 }, newShareToken);
    expect(new Set(minted).size).toBe(50);
    for (const token of minted) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is held only as its hash, which the token cannot be read back out of", async () => {
    const token = newShareToken();
    const subject = await hashShareToken(token);
    expect(subject).toMatch(/^[0-9a-f]{64}$/);
    expect(subject).not.toContain(token);
    expect(await hashShareToken(token)).toBe(subject);
    expect(await hashShareToken(newShareToken())).not.toBe(subject);
  });
});

describe("an email share's id", () => {
  it("is random and names no artifact, so no recipient walks from one share to another", () => {
    const minted = Array.from({ length: 50 }, newShareId);
    expect(new Set(minted).size).toBe(50);
    for (const id of minted) expect(id).toMatch(/^sh_[A-Za-z0-9_-]{22}$/);
    expect(minted[0]?.startsWith(SHARE_ID_PREFIX)).toBe(true);
  });
});

describe("the address an email share is made for", () => {
  it("lower-cases and trims what was typed, so one address is one share", () => {
    expect(parseShareAddress("  Reader@Example.COM ")).toEqual({ ok: true, value: "reader@example.com" });
    expect(parseShareAddress("reader+notes@mail.example.co.uk")).toEqual({
      ok: true,
      value: "reader+notes@mail.example.co.uk",
    });
  });

  it("refuses what is not an address, and says what one holds", () => {
    const refusals = [
      "",
      "reader",
      "reader@example",
      "reader@@example.com",
      "a b@example.com",
      `${"a".repeat(250)}@example.com`,
      42,
    ];
    for (const value of refusals) {
      const parsed = parseShareAddress(value);
      expect([value, parsed.ok]).toEqual([value, false]);
      if (parsed.ok) continue;
      expect(parsed.error).toContain("reader@example.com");
      expect(parsed.error).not.toContain("invalid");
    }
  });
});

describe("the time left on a share", () => {
  const now = 1_700_000_000_000;

  it("says nothing while the expiry is further out than the threshold", () => {
    expect(shareTimeLeft(now + SHARE_SOON_MS + 1, now)).toBe("");
    expect(shareTimeLeft(now + 30 * DAY, now)).toBe("");
  });

  it("counts down from the threshold itself", () => {
    expect(shareTimeLeft(now + SHARE_SOON_MS, now)).toBe("14 days left");
    expect(shareTimeLeft(now + DAY, now)).toBe("1 day left");
    expect(shareTimeLeft(now + 3_600_000, now)).toBe("1 hour left");
    expect(shareTimeLeft(now + 60_000, now)).toBe("1 minute left");
    expect(shareTimeLeft(now + 1, now)).toBe("1 minute left");
  });

  it("says nothing for a share already past its expiry, which no read returns", () => {
    expect(shareTimeLeft(now, now)).toBe("");
    expect(shareTimeLeft(now - DAY, now)).toBe("");
  });
});
