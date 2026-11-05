export type TrackState = "idle" | "buffering" | "playing" | "paused" | "ended" | "unavailable" | "refused";

export interface PlayerState {
  tracks: TrackState[];
  current: number;
}

export type PlayerEvent =
  | { kind: "start"; track: number }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "buffering" }
  | { kind: "playing" }
  | { kind: "ended" }
  | { kind: "refused" }
  | { kind: "next" }
  | { kind: "previous" };

export const NO_TRACK = -1;

const at = (tracks: TrackState[], index: number): TrackState => {
  const track = tracks[index];
  if (track === undefined) throw new RangeError(`the player holds no track at ${index}`);
  return track;
};

const released = (track: TrackState): TrackState => (track === "unavailable" || track === "refused" ? track : "idle");

const everyEnded = (tracks: TrackState[]): TrackState[] =>
  tracks.map((track) => (track === "unavailable" || track === "refused" ? track : "ended"));

const reachable = (tracks: TrackState[], from: number, by: 1 | -1): number => {
  for (let index = from + by; index >= 0 && index < tracks.length; index += by) {
    if (at(tracks, index) !== "unavailable") return index;
  }
  return NO_TRACK;
};

const started = (state: PlayerState, track: number): PlayerState => {
  if (at(state.tracks, track) === "unavailable") return state;
  const tracks = state.tracks.map(released);
  tracks[track] = "buffering";
  return { tracks, current: track };
};

const marked = (state: PlayerState, track: TrackState): PlayerState => {
  const tracks = [...state.tracks];
  tracks[state.current] = track;
  return { tracks, current: state.current };
};

const advanced = (tracks: TrackState[], from: number): PlayerState => {
  const next = reachable(tracks, from, 1);
  if (next === NO_TRACK) return { tracks, current: NO_TRACK };
  const playing = [...tracks];
  playing[next] = "buffering";
  return { tracks: playing, current: next };
};

const moved = (state: PlayerState, by: 1 | -1): PlayerState => {
  const to = reachable(state.tracks, state.current, by);
  if (to === NO_TRACK) return state;
  const tracks = [...state.tracks];
  tracks[state.current] = released(at(state.tracks, state.current));
  tracks[to] = "buffering";
  return { tracks, current: to };
};

export const step = (state: PlayerState, event: PlayerEvent): PlayerState => {
  if (event.kind === "start") return started(state, event.track);
  if (state.current === NO_TRACK) return state;
  const current = at(state.tracks, state.current);
  switch (event.kind) {
    case "pause":
      if (current !== "playing" && current !== "buffering") return state;
      return marked(state, "paused");
    case "resume":
      if (current !== "paused") return state;
      return marked(state, "playing");
    case "buffering":
      if (current !== "playing" && current !== "buffering") return state;
      return marked(state, "buffering");
    case "playing":
      if (current !== "buffering" && current !== "playing" && current !== "paused") return state;
      return marked(state, "playing");
    case "ended": {
      const tracks = [...state.tracks];
      tracks[state.current] = "ended";
      const after = advanced(tracks, state.current);
      if (after.current !== NO_TRACK) return after;
      return { tracks: everyEnded(tracks), current: NO_TRACK };
    }
    case "refused": {
      const tracks = [...state.tracks];
      tracks[state.current] = "refused";
      return advanced(tracks, state.current);
    }
    case "next":
      return moved(state, 1);
    case "previous":
      return moved(state, -1);
  }
};
