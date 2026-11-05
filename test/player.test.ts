import { describe, expect, it } from "vitest";
import { type PlayerEvent, type PlayerState, step, type TrackState } from "../src/player";

const player = (tracks: TrackState[], current: number | null = null): PlayerState => ({ tracks, current });

const walk = (state: PlayerState, events: PlayerEvent[]): PlayerState => events.reduce(step, state);

describe("the audio player's state machine", () => {
  it("buffers the track that was started and marks it playing when the bytes arrive", () => {
    const state = walk(player(["idle", "idle", "idle"]), [{ kind: "start", track: 1 }]);
    expect(state).toEqual({ tracks: ["idle", "buffering", "idle"], current: 1 });
    expect(step(state, { kind: "playing" })).toEqual({ tracks: ["idle", "playing", "idle"], current: 1 });
  });

  it("starting a second track clears the first track's mark", () => {
    const state = walk(player(["idle", "idle"]), [
      { kind: "start", track: 0 },
      { kind: "playing" },
      { kind: "start", track: 1 },
    ]);
    expect(state).toEqual({ tracks: ["idle", "buffering"], current: 1 });
  });

  it("pauses and resumes the current track, holding which row is marked", () => {
    const playing = walk(player(["idle", "idle"]), [{ kind: "start", track: 1 }, { kind: "playing" }]);
    const paused = step(playing, { kind: "pause" });
    expect(paused).toEqual({ tracks: ["idle", "paused"], current: 1 });
    expect(step(paused, { kind: "resume" })).toEqual({ tracks: ["idle", "playing"], current: 1 });
  });

  it("pausing a buffering track cancels the start", () => {
    const state = walk(player(["idle"]), [{ kind: "start", track: 0 }, { kind: "pause" }]);
    expect(state).toEqual({ tracks: ["paused"], current: 0 });
  });

  it("ignores pause and resume when nothing is current", () => {
    const idle = player(["idle", "idle"]);
    expect(step(idle, { kind: "pause" })).toBe(idle);
    expect(step(idle, { kind: "resume" })).toBe(idle);
  });

  it("ending a track marks it ended and starts the next one", () => {
    const state = walk(player(["idle", "idle", "idle"]), [
      { kind: "start", track: 0 },
      { kind: "playing" },
      { kind: "ended" },
    ]);
    expect(state).toEqual({ tracks: ["ended", "buffering", "idle"], current: 1 });
  });

  it("ending the last track marks every track ended and plays nothing", () => {
    const state = walk(player(["idle", "idle"]), [{ kind: "start", track: 1 }, { kind: "playing" }, { kind: "ended" }]);
    expect(state).toEqual({ tracks: ["ended", "ended"], current: null });
  });

  it("starting anything clears every ended mark", () => {
    const ended = player(["ended", "ended", "ended"], null);
    expect(step(ended, { kind: "start", track: 0 })).toEqual({
      tracks: ["buffering", "idle", "idle"],
      current: 0,
    });
  });

  it("holds a refused track's mark and moves to the next row", () => {
    const state = walk(player(["idle", "idle", "idle"]), [
      { kind: "start", track: 1 },
      { kind: "playing" },
      { kind: "refused" },
    ]);
    expect(state).toEqual({ tracks: ["idle", "refused", "buffering"], current: 2 });
  });

  it("keeps a refused mark through a later start and through the end of the list", () => {
    const state = walk(player(["idle", "idle"]), [
      { kind: "start", track: 0 },
      { kind: "refused" },
      { kind: "playing" },
      { kind: "ended" },
    ]);
    expect(state).toEqual({ tracks: ["refused", "ended"], current: null });
  });

  it("starts a refused track again when the reader fires its control", () => {
    const refused = player(["refused", "idle"], null);
    expect(step(refused, { kind: "start", track: 0 })).toEqual({ tracks: ["buffering", "idle"], current: 0 });
  });

  it("plays nothing when the last track is refused", () => {
    const state = walk(player(["idle", "idle"]), [{ kind: "start", track: 1 }, { kind: "refused" }]);
    expect(state).toEqual({ tracks: ["idle", "refused"], current: null });
  });

  it("does nothing when an unavailable track's control is fired", () => {
    const state = player(["unavailable", "idle"]);
    expect(step(state, { kind: "start", track: 0 })).toBe(state);
  });

  it("skips an unavailable track on next, on previous and on the end of a track", () => {
    const tracks: TrackState[] = ["idle", "unavailable", "idle"];
    expect(step(player(tracks, 0), { kind: "next" })).toEqual({
      tracks: ["idle", "unavailable", "buffering"],
      current: 2,
    });
    expect(step(player(tracks, 2), { kind: "previous" })).toEqual({
      tracks: ["buffering", "unavailable", "idle"],
      current: 0,
    });
    expect(step(player(["playing", "unavailable", "idle"], 0), { kind: "ended" })).toEqual({
      tracks: ["ended", "unavailable", "buffering"],
      current: 2,
    });
  });

  it("holds an unavailable mark when every other track has ended", () => {
    const state = step(player(["ended", "unavailable", "playing"], 2), { kind: "ended" });
    expect(state).toEqual({ tracks: ["ended", "unavailable", "ended"], current: null });
  });

  it("leaves next and previous inert at the ends of the list and when nothing plays", () => {
    const last = player(["idle", "playing"], 1);
    expect(step(last, { kind: "next" })).toBe(last);
    const first = player(["playing", "idle"], 0);
    expect(step(first, { kind: "previous" })).toBe(first);
    const nothing = player(["idle", "idle"]);
    expect(step(nothing, { kind: "next" })).toBe(nothing);
    expect(step(nothing, { kind: "previous" })).toBe(nothing);
  });

  it("marks a stall on a playing track and clears it when playback resumes", () => {
    const stalled = step(player(["playing"], 0), { kind: "buffering" });
    expect(stalled).toEqual({ tracks: ["buffering"], current: 0 });
    expect(step(stalled, { kind: "playing" })).toEqual({ tracks: ["playing"], current: 0 });
  });

  it("refuses to step a track the player does not hold", () => {
    expect(() => step(player(["idle"]), { kind: "start", track: 3 })).toThrow(RangeError);
  });
});
