// The browser reads the transcript, not the Worker. The page carries a manifest — every stretch of
// the chosen file, where it sits and how long it is, off one listing — and this script fetches the
// bytes of the stretches it wants off a route that opens one object and streams it. Nothing here
// asks the server where an entry ends or what a window is.
//
// The arithmetic of the walk lives in transcript-plan, and what counts as a turn lives in turns,
// which is the reader the index itself runs. This file is the document and the network around
// them. npm-scripts/build-browser.mjs bundles it to the script served at /transcript.js.
//
// A session still being written is followed as well as read: the box beats against the same route
// asking how far the file now reaches, and reads forward from where it has got to. The beat runs
// on the client and nothing on the server ever goes looking for a session to follow.

import type { Run } from "../src/transcript-plan";
import {
  type Fetched,
  followedBatch,
  followedTexts,
  groupedReads,
  joinedTexts,
  type PlannedRead,
  plannedBatch,
  walkNote,
} from "../src/transcript-plan";
import { readTurns, type Turn } from "../src/turns";

// Where the box starts following a file still being written, and how often it beats.
interface Follow {
  from: number;
  every: number;
}

interface Plan {
  path: string;
  file: string;
  bytes: number;
  step: number;
  runs: Run[];
  follow: Follow | null;
}

// What the server says of a file still being written: how far it reaches, whether anyone is still
// running the session, and the stretches past the offset the box asked about.
interface Reach {
  bytes: number;
  running: boolean;
  runs: Run[];
}

const isReach = (value: unknown): value is Reach =>
  typeof value === "object" &&
  value !== null &&
  "bytes" in value &&
  typeof value.bytes === "number" &&
  "running" in value &&
  typeof value.running === "boolean" &&
  "runs" in value &&
  Array.isArray(value.runs);

// How many batches in a row may come back with no prose in them before the reader stops and says
// so. A transcript is mostly machinery — tool calls, results, file snapshots — and a stretch of
// nothing else would otherwise be walked to the head of the file one fetch at a time on page open.
const BLANK_STEPS = 4;

// How many beats in a row may fail before the box stops following and says so. The archive is
// written to while it is read, so one refused beat means nothing; a run of them means the box is
// no longer showing what the session is saying, and a reader must not have to guess that.
const FOLLOW_TRIES = 3;

// How near the foot of the box counts as being at the foot. A reader watching the bottom is
// carried along; a reader who has scrolled back is left exactly where they are.
const FOOT_SLACK = 32;

const moment = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ");

const rendered = (turns: Turn[]): DocumentFragment => {
  const held = document.createDocumentFragment();
  for (const turn of turns) {
    const row = document.createElement("li");
    row.className = `turn ${turn.speaker}`;
    const who = document.createElement("p");
    who.className = "who";
    who.textContent = `${turn.speaker === "user" ? "you" : "claude"}${turn.at === 0 ? "" : ` · ${moment(turn.at)}`}`;
    const said = document.createElement("pre");
    said.className = "say";
    said.textContent = turn.text;
    row.appendChild(who);
    row.appendChild(said);
    held.appendChild(row);
  }
  return held;
};

type Got = { ok: true; text: string } | { ok: false; why: string; signedOut: boolean };

const boot = (box: HTMLElement, list: HTMLElement, note: HTMLElement, more: HTMLElement, plan: Plan): void => {
  const reads: PlannedRead[] = [];
  plan.runs.forEach((run, index) => {
    for (const read of run.reads) {
      reads.push({ run: index, offset: read.offset, skip: read.skip, bytes: read.bytes });
    }
  });

  let edge = reads.length;
  let pending = reads[edge - 1]?.bytes ?? 0;
  let remnant = "";
  let loaded = 0;
  let blanks = 0;
  let blankBytes = 0;
  let busy = false;
  let broken = false;

  // The forward cursor and what hangs off it. `at` starts at the end of the manifest the page was
  // handed, which is the first byte the backward walk will never read, so following can only ever
  // add turns the box has not shown. `reaches` grows with the file, so the note counts against
  // what the archive holds now rather than what it held when the page was drawn.
  const following = plan.follow;
  let at = following === null ? 0 : following.from;
  let reaches = plan.bytes;
  let trailing = "";
  let newer = 0;
  let ended = false;
  let misses = 0;
  let beating = 0;

  // A failure holds the box: it stays on screen until the reader asks again, so the next thing the
  // page has to say cannot quietly take its place and leave a reader short of the file with
  // nothing on screen to say so.
  const say = (text: string): void => {
    if (broken) return;
    note.className = "txnote";
    note.textContent = text;
  };

  const answered = async (response: Response, where: number): Promise<Got> => {
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return {
        ok: false,
        signedOut: true,
        why: "Your dashboard sign-in has ended, so the transcript stopped loading.",
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        signedOut: false,
        why: `The archive holds no stretch at ${where} of ${plan.file}, so it and this page disagree about what it holds.`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        signedOut: false,
        why: `Reading ${plan.file} at ${where} failed with ${response.status} ${response.statusText}.`,
      };
    }
    return { ok: true, text: await response.text() };
  };

  const asked = (url: string, headers: HeadersInit, where: number): Promise<Got> =>
    fetch(url, { headers, credentials: "same-origin", redirect: "manual" })
      .then((response) => answered(response, where))
      .catch((error: unknown) => ({
        ok: false as const,
        signedOut: false,
        why: `Reading ${plan.file} failed: ${error instanceof Error ? error.message : String(error)}.`,
      }));

  const grab = (read: PlannedRead): Promise<Got> =>
    asked(
      `${plan.path}?file=${encodeURIComponent(plan.file)}&at=${read.offset}`,
      { range: `bytes=${read.skip}-${read.skip + read.bytes - 1}` },
      read.offset,
    );

  const noteFor = (dry: number): string =>
    walkNote({
      file: plan.file,
      bytes: reaches,
      loaded,
      shown: list.childElementCount,
      dry,
      through: edge === 0,
      newer,
      ended,
    });

  const atFoot = (): boolean => box.scrollHeight - box.scrollTop - box.clientHeight < FOOT_SLACK;

  const stopFollowing = (): void => {
    if (beating === 0) return;
    clearInterval(beating);
    beating = 0;
  };

  const done = (): void => {
    more.remove();
    say(noteFor(0));
  };

  // A read that cannot be had says which read and why, and offers the one control that gets past
  // it: another go at a transport failure, and a reload for a sign-in that has run out, since only
  // a fresh navigation goes back through Access. Following stops with it, so a box that has given
  // up says so under a control that starts it again rather than beating on behind a dead note.
  const fail = (why: string, signedOut: boolean, retry: () => void): void => {
    broken = true;
    stopFollowing();
    note.className = "txnote bad";
    note.textContent = `${why} `;
    more.setAttribute("disabled", "");
    if (signedOut) {
      const again = document.createElement("a");
      again.href = location.pathname + location.search;
      again.textContent = "Reload this page";
      note.appendChild(again);
      return;
    }
    const again = document.createElement("button");
    again.type = "button";
    again.textContent = "Try again";
    again.addEventListener("click", () => {
      broken = false;
      more.removeAttribute("disabled");
      retry();
    });
    note.appendChild(again);
  };

  const retryLoad = (): void => {
    startFollowing();
    void load();
  };

  const load = async (): Promise<void> => {
    if (busy || broken) return;
    if (edge === 0) return done();
    busy = true;
    more.setAttribute("disabled", "");
    say(`Reading ${plan.file}…`);

    const planned = plannedBatch(reads, edge, pending, plan.step);
    const fetched: Fetched[] = [];
    for (const read of planned.batch) {
      const got = await grab(read);
      if (!got.ok) {
        busy = false;
        fail(got.why, got.signedOut, retryLoad);
        return;
      }
      fetched.push({ ...read, text: got.text });
    }
    edge = planned.edge;
    pending = planned.pending;
    let walked = 0;
    for (const read of planned.batch) walked += read.bytes;
    loaded += walked;

    const joined = joinedTexts(groupedReads(fetched), plan.runs, remnant);
    remnant = joined.remnant;

    const held = box.scrollHeight - box.scrollTop;
    const before = list.childElementCount;
    for (const text of joined.texts) list.insertBefore(rendered(readTurns(text, plan.file)), list.firstChild);
    box.scrollTop = box.scrollHeight - held;

    busy = false;
    const blank = list.childElementCount === before;
    blanks = blank ? blanks + 1 : 0;
    blankBytes = blank ? blankBytes + walked : 0;
    if (edge === 0) return done();
    more.removeAttribute("disabled");
    if (blanks >= BLANK_STEPS) {
      const dry = blankBytes;
      blanks = 0;
      blankBytes = 0;
      say(noteFor(dry));
      return;
    }
    say(noteFor(0));
    if (blank) return load();
  };

  const missed = (why: string, signedOut: boolean): void => {
    misses += 1;
    if (misses < FOLLOW_TRIES) return;
    fail(why, signedOut, () => {
      misses = 0;
      startFollowing();
      beat();
    });
  };

  // One beat. It asks how far the file now reaches, and reads forward only over what it has not
  // read: nothing already on screen is fetched again, and the cursor moves only by the bytes that
  // came back. A batch is capped at the same step the backward walk takes, so a tab left hidden
  // for an hour catches up over several beats rather than in one enormous read.
  const follow = async (): Promise<void> => {
    if (following === null || busy || broken) return;
    busy = true;
    const got = await asked(`${plan.path}?file=${encodeURIComponent(plan.file)}&from=${at}`, {}, at);
    if (!got.ok) {
      busy = false;
      missed(got.why, got.signedOut);
      return;
    }
    const reach: unknown = JSON.parse(got.text);
    if (!isReach(reach)) {
      busy = false;
      missed(`Following ${plan.file} got an answer this page cannot read.`, false);
      return;
    }
    const planned = followedBatch(reach.runs, at, plan.step);
    const fetched: Fetched[] = [];
    for (const read of planned.batch) {
      const one = await grab(read);
      if (!one.ok) {
        busy = false;
        missed(one.why, one.signedOut);
        return;
      }
      fetched.push({ ...read, text: one.text });
    }
    misses = 0;

    // The part line held from the last beat belongs to the bytes just before this batch. A batch
    // that does not start there sits across a hole, and nothing is carried over one.
    const head = planned.batch[0];
    if (head !== undefined && head.offset + head.skip !== at) trailing = "";
    let walked = 0;
    for (const read of planned.batch) walked += read.bytes;
    at = planned.at;
    reaches += walked;
    loaded += walked;

    const joined = followedTexts(groupedReads(fetched), trailing);
    trailing = joined.remnant;
    const foot = atFoot();
    const before = list.childElementCount;
    for (const text of joined.texts) list.appendChild(rendered(readTurns(text, plan.file)));
    const added = list.childElementCount - before;
    if (foot) {
      box.scrollTop = box.scrollHeight;
      newer = 0;
    } else {
      newer += added;
    }
    busy = false;

    if (!reach.running) {
      ended = true;
      stopFollowing();
    }
    if (added > 0 || ended) say(noteFor(0));
  };

  const beat = (): void => {
    void follow().catch((error: unknown) => {
      busy = false;
      missed(`Following ${plan.file} failed: ${error instanceof Error ? error.message : String(error)}.`, false);
    });
  };

  // Nothing beats at a session nobody is running, at a box that has given up, at a file already
  // done, or at a tab nobody is looking at.
  const startFollowing = (): void => {
    if (following === null || beating !== 0 || broken || ended || document.hidden) return;
    beating = setInterval(beat, following.every);
  };

  more.addEventListener("click", () => {
    void load();
  });
  box.addEventListener("scroll", () => {
    if (box.scrollTop < 240) void load();
    if (newer > 0 && atFoot()) {
      newer = 0;
      say(noteFor(0));
    }
  });

  if (following !== null) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopFollowing();
        return;
      }
      startFollowing();
      beat();
    });
    window.addEventListener("pagehide", stopFollowing);
  }

  void load().then(() => {
    box.scrollTop = box.scrollHeight;
    startFollowing();
  });
};

const box = document.getElementById("tx");
const list = document.getElementById("txlist");
const note = document.getElementById("txnote");
const more = document.getElementById("txmore");
const source = document.getElementById("txplan");
if (box === null || list === null || note === null || more === null || source === null) {
  throw new Error("the session page carries no transcript box");
}
boot(box, list, note, more, JSON.parse(source.textContent ?? "") as Plan);
