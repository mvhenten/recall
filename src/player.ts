export type TrackState = "idle" | "buffering" | "playing" | "paused" | "ended" | "unavailable" | "refused";

// Nothing plays until a reader starts something, and nothing plays again once the list has run
// out, so `current` is null in both and no row index stands in for the absence of one.
export interface PlayerState {
  tracks: TrackState[];
  current: number | null;
}

// The manifest the player page carries into the browser: the base the page was served under, so a
// row's control addresses the file inside whatever address space the reader is in, and whether
// storage holds the file at all. A base rather than a name, because a player served under a share
// prefix cannot reach its files by the artifact's name.
export interface PlannedTrack {
  path: string;
  gone: boolean;
}

export interface PlayerPlan {
  base: string;
  tracks: PlannedTrack[];
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

const at = (tracks: TrackState[], index: number): TrackState => {
  const track = tracks[index];
  if (track === undefined) throw new RangeError(`the player holds no track at ${index}`);
  return track;
};

const released = (track: TrackState): TrackState => (track === "unavailable" || track === "refused" ? track : "idle");

const everyEnded = (tracks: TrackState[]): TrackState[] =>
  tracks.map((track) => (track === "unavailable" || track === "refused" ? track : "ended"));

const reachable = (tracks: TrackState[], from: number, by: 1 | -1): number | null => {
  for (let index = from + by; index >= 0 && index < tracks.length; index += by) {
    if (at(tracks, index) !== "unavailable") return index;
  }
  return null;
};

const started = (state: PlayerState, track: number): PlayerState => {
  if (at(state.tracks, track) === "unavailable") return state;
  const tracks = state.tracks.map(released);
  tracks[track] = "buffering";
  return { tracks, current: track };
};

const marked = (state: PlayerState, current: number, track: TrackState): PlayerState => {
  const tracks = [...state.tracks];
  tracks[current] = track;
  return { tracks, current };
};

const advanced = (tracks: TrackState[], from: number): PlayerState => {
  const next = reachable(tracks, from, 1);
  if (next === null) return { tracks, current: null };
  const playing = [...tracks];
  playing[next] = "buffering";
  return { tracks: playing, current: next };
};

const moved = (state: PlayerState, current: number, by: 1 | -1): PlayerState => {
  const to = reachable(state.tracks, current, by);
  if (to === null) return state;
  const tracks = [...state.tracks];
  tracks[current] = released(at(state.tracks, current));
  tracks[to] = "buffering";
  return { tracks, current: to };
};

export const step = (state: PlayerState, event: PlayerEvent): PlayerState => {
  if (event.kind === "start") return started(state, event.track);
  const { current } = state;
  if (current === null) return state;
  const track = at(state.tracks, current);
  switch (event.kind) {
    case "pause":
      if (track !== "playing" && track !== "buffering") return state;
      return marked(state, current, "paused");
    case "resume":
      if (track !== "paused") return state;
      return marked(state, current, "playing");
    case "buffering":
      if (track !== "playing" && track !== "buffering") return state;
      return marked(state, current, "buffering");
    case "playing":
      if (track !== "buffering" && track !== "playing" && track !== "paused") return state;
      return marked(state, current, "playing");
    case "ended": {
      const tracks = [...state.tracks];
      tracks[current] = "ended";
      const after = advanced(tracks, current);
      if (after.current !== null) return after;
      return { tracks: everyEnded(tracks), current: null };
    }
    case "refused": {
      const tracks = [...state.tracks];
      tracks[current] = "refused";
      return advanced(tracks, current);
    }
    case "next":
      return moved(state, current, 1);
    case "previous":
      return moved(state, current, -1);
  }
};
