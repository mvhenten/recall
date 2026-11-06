// The player's wiring. Every decision about which row is playing, which is marked and where the
// player goes next lives in src/player.ts and is unit tested; this file is the document and the
// one audio element around it, and holds no state machine of its own.
//
// The bytes are the browser's to fetch. Each track's src is the file's own address, so the
// element issues its own range requests and a drag of the scrubber continues from that point
// without the whole file being fetched first. Nothing here fetches audio.
//
// npm-scripts/build-browser.mjs bundles this to the script the player page names.

import { type PlayerEvent, type PlayerPlan, type PlayerState, step, type TrackState } from "../src/player";

const TAGS: Record<TrackState, string> = {
  idle: "",
  buffering: "BUFFERING",
  playing: "PLAYING",
  paused: "PAUSED",
  ended: "ENDED",
  unavailable: "UNAVAILABLE",
  refused: "ERROR",
};

const REFUSED_WHY = "This browser cannot play this file. Republish it in a format the browser plays.";

interface Parts {
  audio: HTMLAudioElement;
  prev: HTMLButtonElement;
  play: HTMLButtonElement;
  next: HTMLButtonElement;
  now: HTMLElement;
  seek: HTMLInputElement;
  at: HTMLElement;
}

const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

const boot = (parts: Parts, plan: PlayerPlan): void => {
  const { audio, prev, play, next, now, seek, at } = parts;
  const rows = plan.tracks.map((_, index) => document.querySelector(`#tr${index}`));
  const tags = plan.tracks.map((_, index) => document.querySelector(`#tg${index}`));
  const whys = plan.tracks.map((_, index) => document.querySelector(`#wy${index}`));
  const controls = plan.tracks.map((_, index) =>
    document.querySelector<HTMLButtonElement>(`#tr${index} button[data-track]`),
  );

  let state: PlayerState = {
    tracks: plan.tracks.map((track) => (track.gone ? "unavailable" : "idle")),
    current: null,
  };
  let loaded: number | null = null;
  let dragging = false;

  const firstPlayable = plan.tracks.findIndex((track) => !track.gone);

  // A file answers under the file space of whatever base served the page, so the same line
  // addresses a track on an artifact's own page and on a shared one. The segment is written out
  // rather than imported from src/shares.ts, which would pull that module's dependencies into the
  // bundle; it is FILE_SEGMENT there, and the test that plays a shared track fetches the address
  // this line builds, so moving the segment fails that test rather than the player.
  const addressOf = (index: number): string => {
    const track = plan.tracks[index];
    if (track === undefined) throw new RangeError(`the player page names no track at ${index}`);
    return `${plan.base}/f/${track.path.split("/").map(encodeURIComponent).join("/")}`;
  };

  const nameOf = (index: number): string => plan.tracks[index]?.path ?? "";

  const anyEnded = (): boolean => state.tracks.some((track) => track === "ended");

  const paused = (index: number): boolean => state.tracks[index] === "paused";

  const running = (index: number): boolean => {
    const track = state.tracks[index];
    return track === "playing" || track === "buffering";
  };

  const transportSays = (): string => {
    if (state.current === null) return anyEnded() ? "Every track ended." : "Nothing is playing.";
    const tag = TAGS[state.tracks[state.current] ?? "idle"];
    return `${nameOf(state.current)}${tag === "" ? "" : ` · ${tag.toLowerCase()}`}`;
  };

  const times = (): void => {
    const total = audio.duration;
    const playable = state.current !== null && Number.isFinite(total) && total > 0;
    at.textContent = `${clock(playable ? audio.currentTime : Number.NaN)} / ${clock(playable ? total : Number.NaN)}`;
    seek.disabled = !playable;
    if (!playable) {
      seek.max = "0";
      seek.value = "0";
      return;
    }
    seek.max = String(Math.floor(total));
    if (!dragging) seek.value = String(Math.floor(audio.currentTime));
  };

  const draw = (): void => {
    state.tracks.forEach((track, index) => {
      const row = rows[index];
      if (row) {
        if (index === state.current) row.setAttribute("aria-current", "true");
        else row.removeAttribute("aria-current");
      }
      const tag = tags[index];
      if (tag) tag.textContent = TAGS[track];
      // A refused row keeps its reason after the player has moved on, so a reader can still read
      // what failed. An unavailable row's reason was drawn by the server and is never rewritten.
      const why = whys[index];
      if (why && track === "refused") why.textContent = REFUSED_WHY;
      const control = controls[index];
      if (control && track !== "unavailable") {
        control.textContent = index === state.current && running(index) ? "Pause" : "Play";
      }
    });
    play.textContent = state.current !== null && running(state.current) ? "Pause" : anyEnded() ? "Replay" : "Play";
    now.textContent = transportSays();
    prev.disabled = state.current === null;
    next.disabled = state.current === null;
    times();
  };

  const apply = (event: PlayerEvent): void => {
    const after = step(state, event);
    if (after === state) return;
    state = after;
    draw();
    if (event.kind === "pause") {
      audio.pause();
      return;
    }
    // Buffering and playing are the element reporting what it is already doing.
    if (event.kind === "buffering" || event.kind === "playing") return;
    const index = state.current;
    if (index === null) {
      audio.pause();
      loaded = null;
      return;
    }
    if (index !== loaded) {
      loaded = index;
      audio.src = addressOf(index);
    } else if (event.kind === "start") {
      audio.currentTime = 0;
    }
    audio.play().catch(() => {
      apply({ kind: "refused" });
    });
  };

  // One control, three meanings, decided by what the track it names is doing. A row whose file
  // storage does not hold keeps its control and its place in the tab order; the machine refuses
  // the start, so firing it changes nothing.
  const toggle = (index: number): void => {
    if (index !== state.current) {
      apply({ kind: "start", track: index });
      return;
    }
    if (running(index)) apply({ kind: "pause" });
    else if (paused(index)) apply({ kind: "resume" });
    else apply({ kind: "start", track: index });
  };

  controls.forEach((control, index) => {
    control?.addEventListener("click", () => {
      toggle(index);
    });
  });

  play.addEventListener("click", () => {
    if (state.current !== null) {
      toggle(state.current);
      return;
    }
    if (firstPlayable === -1) return;
    apply({ kind: "start", track: firstPlayable });
  });

  prev.addEventListener("click", () => {
    apply({ kind: "previous" });
  });
  next.addEventListener("click", () => {
    apply({ kind: "next" });
  });

  seek.addEventListener("input", () => {
    dragging = true;
    audio.currentTime = Number(seek.value);
  });
  seek.addEventListener("change", () => {
    dragging = false;
  });

  audio.addEventListener("waiting", () => {
    apply({ kind: "buffering" });
  });
  audio.addEventListener("playing", () => {
    apply({ kind: "playing" });
  });
  audio.addEventListener("ended", () => {
    apply({ kind: "ended" });
  });
  audio.addEventListener("error", () => {
    if (state.current === null) return;
    apply({ kind: "refused" });
  });
  audio.addEventListener("loadedmetadata", times);
  audio.addEventListener("timeupdate", times);
  audio.addEventListener("durationchange", times);

  draw();
};

const audio = document.querySelector<HTMLAudioElement>("#paudio");
const prev = document.querySelector<HTMLButtonElement>("#pprev");
const play = document.querySelector<HTMLButtonElement>("#pplay");
const next = document.querySelector<HTMLButtonElement>("#pnext");
const now = document.querySelector<HTMLElement>("#pnow");
const seek = document.querySelector<HTMLInputElement>("#pseek");
const at = document.querySelector<HTMLElement>("#pat");
const source = document.querySelector<HTMLElement>("#pplan");
if (
  audio === null ||
  prev === null ||
  play === null ||
  next === null ||
  now === null ||
  seek === null ||
  at === null ||
  source === null
) {
  throw new Error("the artifact page carries no player");
}
boot({ audio, prev, play, next, now, seek, at }, JSON.parse(source.textContent ?? "") as PlayerPlan);
