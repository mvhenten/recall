// The browser reads the transcript, not the Worker. The page carries a manifest — every window of
// the chosen file and where it sits, off one listing — and this script fetches the prose of the
// windows it wants off a route that opens the archive and streams it. Nothing here asks the server
// where an entry ends or what a window is.
//
// The archive takes a transcript on two paths and the manifest says which this file is held on. A
// file the byte path wrote is walked in bytes: a stretch is a span of the file on disk, a stretch
// boundary is not a line boundary, and the part line at each edge of a batch is carried to the
// batch beside it. A file the record path wrote is walked in ordinals: a record is one whole line
// verbatim, so a window of them needs no range, no joining and no remnant at all.
//
// The arithmetic of both walks lives in transcript-plan, and what counts as a turn lives in turns,
// which is the reader the index itself runs. This file is the document and the network around
// them. npm-scripts/build-browser.mjs bundles it to the script served at /transcript.js.
//
// A session still being written is followed as well as read: the box beats against the same route
// asking how far the file now reaches, and reads forward from where it has got to. The beat runs
// on the client and nothing on the server ever goes looking for a session to follow.

import {
  type BytePlan,
  type Fetched,
  followedBatch,
  followedRecords,
  followedTexts,
  groupedReads,
  joinedTexts,
  type Plan,
  type PlannedRead,
  packedStretch,
  plannedBatch,
  plannedRecords,
  type Reach,
  type RecordPlan,
  type RecordReach,
  type Tail,
  tailNote,
  walkNote,
} from "../src/transcript-plan";
import { readTurns, type Turn } from "../src/turns";

// How many batches in a row may come back with no prose in them before the reader stops and says
// so. A transcript is mostly machinery — tool calls, results, file snapshots — and a stretch of
// nothing else would otherwise be walked to the head of the file one fetch at a time on page open.
const BLANK_STEPS = 4;

// How many beats in a row may fail before the box stops following and says so. The archive is
// written to while it is read, so one refused beat means nothing; a run of them means the box is
// no longer showing what the session is saying, and a reader must not have to guess that.
const FOLLOW_TRIES = 3;

// The slowest the box beats. Each beat that brings no bytes doubles the wait up to this, and the
// first that brings some puts it back to the pace the page chose. Only a tab someone is looking
// at beats at all, so this is paid by a reader watching the box: a minute is as long as one may
// be left waiting for a turn the archive already holds.
const FOLLOW_SLOWEST_MS = 60_000;

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

interface Parts {
  box: HTMLElement;
  list: HTMLElement;
  note: HTMLElement;
  tail: HTMLElement;
  more: HTMLElement;
}

const answered = async (response: Response, file: string, where: string): Promise<Got> => {
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
      why: `The archive holds nothing at ${where} of ${file}, so it and this page disagree about what it holds.`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      signedOut: false,
      why: `Reading ${file} at ${where} failed with ${response.status} ${response.statusText}.`,
    };
  }
  return { ok: true, text: await response.text() };
};

const asked = (file: string, url: string, headers: HeadersInit, where: string): Promise<Got> =>
  fetch(url, { headers, credentials: "same-origin", redirect: "manual" })
    .then((response) => answered(response, file, where))
    .catch((error: unknown) => ({
      ok: false as const,
      signedOut: false,
      why: `Reading ${file} failed: ${error instanceof Error ? error.message : String(error)}.`,
    }));

// The one control that gets past a read that cannot be had: another go at a transport failure,
// and a reload for a sign-in that has run out, since only a fresh navigation goes back through
// Access.
const control = (signedOut: boolean, retry: () => void): HTMLElement => {
  if (signedOut) {
    const back = document.createElement("a");
    back.href = location.pathname + location.search;
    back.textContent = "Reload this page";
    return back;
  }
  const again = document.createElement("button");
  again.type = "button";
  again.textContent = "Try again";
  again.addEventListener("click", retry);
  return again;
};

// The two lines the box talks through, and the state that keeps a failure on screen. The walk and
// the follow fail apart from each other: they read different objects, so a tail nobody can read
// says nothing about how far back the reader can walk, and a walk that has given up must not take
// the live news down with it.
interface Notes {
  broken: () => boolean;
  adrift: () => boolean;
  say: (text: string) => void;
  sayTail: (state: Tail) => void;
  /// A read the walk cannot have says which read and why, and holds the box until the reader asks
  /// again, so the next thing the page has to say cannot leave a reader short of the file with
  /// nothing on screen to say so.
  fail: (why: string, signedOut: boolean, retry: () => void) => void;
  /// Following has given up, and says so on its own line under its own control. The walk's
  /// controls are left alone: "Load earlier" reads prose this has never touched.
  lost: (why: string, signedOut: boolean, retry: () => void) => void;
}

const notesOf = (note: HTMLElement, tail: HTMLElement, more: HTMLElement): Notes => {
  let broken = false;
  let adrift = false;
  return {
    broken: () => broken,
    adrift: () => adrift,
    say: (text) => {
      if (broken) return;
      note.className = "txnote";
      note.textContent = text;
    },
    sayTail: (state) => {
      if (adrift) return;
      tail.className = "txnote";
      tail.textContent = tailNote(state);
    },
    fail: (why, signedOut, retry) => {
      broken = true;
      note.className = "txnote bad";
      note.textContent = `${why} `;
      more.setAttribute("disabled", "");
      note.appendChild(
        control(signedOut, () => {
          broken = false;
          more.removeAttribute("disabled");
          retry();
        }),
      );
    },
    lost: (why, signedOut, retry) => {
      adrift = true;
      tail.className = "txnote bad";
      tail.textContent = `${why} `;
      tail.appendChild(
        control(signedOut, () => {
          adrift = false;
          retry();
        }),
      );
    },
  };
};

const bootBytes = ({ box, list, note, tail, more }: Parts, plan: BytePlan): void => {
  const notes = notesOf(note, tail, more);
  const reads: PlannedRead[] = [];
  plan.runs.forEach((run, index) => {
    for (const read of run.reads) {
      reads.push({ run: index, at: read.at, offset: read.offset, skip: read.skip, bytes: read.bytes });
    }
  });

  let edge = reads.length;
  let pending = reads[edge - 1]?.bytes ?? 0;
  let remnant = "";
  let loaded = 0;
  let blanks = 0;
  let blankBytes = 0;
  let busy = false;

  // The forward cursor and what hangs off it. `at` is how far the file has been read to: it
  // starts at the end of the manifest the page was handed, which is the first byte the backward
  // walk will never read, so following can only ever add turns the box has not shown. `after` is
  // the stretch that cursor is the end of, and goes up with it: it is what lets a beat list one
  // page of the end of the file rather than every object in front of it. `reaches` grows with the
  // file, so the note counts against what the archive holds now rather than what it held when the
  // page was drawn.
  const following = plan.follow;
  const pace = following === null ? 0 : following.every;
  let at = following === null ? 0 : following.from;
  let after = reads[reads.length - 1]?.at ?? "";
  let reaches = plan.readable;
  let trailing = "";
  let newer = 0;
  let ended = false;
  let misses = 0;
  let beating = 0;
  let every = pace;
  let chasing = false;

  // One read, fetched off the route that opens one object. A stretch stored gzipped is one gzip
  // member: there is no part of it to ask for, the manifest never splits a read of one, and the
  // browser inflates what comes back, so that one is asked for whole and without a range.
  const grab = (read: PlannedRead): Promise<Got> => {
    const url = `${plan.path}?file=${encodeURIComponent(plan.file)}&at=${read.at}`;
    if (packedStretch(read.at) !== null) return asked(plan.file, url, {}, read.at);
    return asked(plan.file, url, { range: `bytes=${read.skip}-${read.skip + read.bytes - 1}` }, read.at);
  };

  const noteFor = (dry: number): string =>
    walkNote({ file: plan.file, bytes: reaches, loaded, shown: list.childElementCount, dry, through: edge === 0 });

  const atFoot = (): boolean => box.scrollHeight - box.scrollTop - box.clientHeight < FOOT_SLACK;

  const stopFollowing = (): void => {
    if (beating === 0) return;
    clearTimeout(beating);
    beating = 0;
  };

  const done = (): void => {
    more.remove();
    notes.say(noteFor(0));
  };

  const load = async (): Promise<void> => {
    if (busy || notes.broken()) return;
    if (edge === 0) return done();
    busy = true;
    more.setAttribute("disabled", "");
    notes.say(`Reading ${plan.file}…`);

    const planned = plannedBatch(reads, edge, pending, plan.step);
    const fetched: Fetched[] = [];
    for (const read of planned.batch) {
      const got = await grab(read);
      if (!got.ok) {
        busy = false;
        notes.fail(got.why, got.signedOut, () => void load());
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
      notes.say(noteFor(dry));
      return;
    }
    notes.say(noteFor(0));
    if (blank) return load();
  };

  const missed = (why: string, signedOut: boolean): void => {
    misses += 1;
    if (misses < FOLLOW_TRIES) return;
    stopFollowing();
    notes.lost(why, signedOut, () => {
      misses = 0;
      every = pace;
      notes.sayTail({ newer, ended });
      startFollowing();
    });
  };

  // One beat. It asks how the end of the file now lays out, and reads forward only over what it
  // has not read: nothing already on screen is fetched again, and the cursor moves only by the
  // bytes that came back. A batch is capped at the same step the backward walk takes, so a tab
  // left hidden for an hour catches up over several beats rather than in one enormous read.
  const follow = async (): Promise<void> => {
    if (following === null || chasing || notes.adrift()) return;
    chasing = true;
    const got = await asked(
      plan.file,
      `${plan.path}?file=${encodeURIComponent(plan.file)}&from=${at}&after=${encodeURIComponent(after)}`,
      {},
      String(at),
    );
    if (!got.ok) {
      chasing = false;
      missed(got.why, got.signedOut);
      return;
    }
    const reach = JSON.parse(got.text) as Reach;
    const planned = followedBatch(reach.runs, at, plan.step);
    const fetched: Fetched[] = [];
    for (const read of planned.batch) {
      const one = await grab(read);
      if (!one.ok) {
        chasing = false;
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
    // The batch ends where the last read of it ends, which is the end of that stretch: the cursor
    // and the stretch it names go up together, so the next beat's page opens exactly there.
    const last = planned.batch[planned.batch.length - 1];
    if (last !== undefined) after = last.at;
    at = planned.at;
    reaches += walked;
    loaded += walked;
    // A batch cut off by its own budget leaves the box behind what the listing already named, so
    // the next beat follows at once rather than waiting out a pace meant for a box that is level.
    const listed = reach.runs[reach.runs.length - 1]?.to ?? at;
    if (at < listed) every = 0;
    else every = walked > 0 ? pace : Math.min(every * 2, FOLLOW_SLOWEST_MS);

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
    chasing = false;

    if (!reach.running) {
      ended = true;
      stopFollowing();
    }
    if (walked > 0) notes.say(noteFor(0));
    notes.sayTail({ newer, ended });
  };

  const beat = (): void => {
    void follow()
      .catch((error: unknown) => {
        chasing = false;
        missed(`Following ${plan.file} failed: ${error instanceof Error ? error.message : String(error)}.`, false);
      })
      .then(rest);
  };

  // When the next beat falls due. Nothing is waiting at a session that has ended, at a box that
  // has given up following, or at a tab nobody is looking at.
  const rest = (): void => {
    if (following === null || notes.adrift() || ended || document.hidden) return;
    beating = setTimeout(() => {
      beating = 0;
      beat();
    }, every);
  };

  // Following starts on the beat it fires here, and starting it twice beats once.
  const startFollowing = (): void => {
    if (following === null || beating !== 0 || chasing || notes.adrift() || ended || document.hidden) return;
    beat();
  };

  more.addEventListener("click", () => {
    void load();
  });
  box.addEventListener("scroll", () => {
    if (box.scrollTop < 240) void load();
    if (newer > 0 && atFoot()) {
      newer = 0;
      notes.sayTail({ newer, ended });
    }
  });

  if (following !== null) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopFollowing();
        return;
      }
      startFollowing();
    });
    window.addEventListener("pagehide", stopFollowing);
  }

  void load().then(() => {
    box.scrollTop = box.scrollHeight;
    startFollowing();
  });
};

// The same box over a file the record path holds. A record is one whole line verbatim, so a window
// of them is two ordinals and comes back as prose that parses on its own: there is no range to ask
// for, no part line to carry between windows, and no stretch boundary to join across. Where the
// objects covering a window do not tile it the archive answers nothing at all, which is a failure
// the box says out loud rather than a short read it renders as the file.
const bootRecords = ({ box, list, note, tail, more }: Parts, plan: RecordPlan): void => {
  const notes = notesOf(note, tail, more);
  const spans = plan.spans;
  const first = spans[0]?.from ?? 0;
  const end = spans[spans.length - 1];

  let edge = end === undefined ? 0 : end.from + end.held;
  let loaded = 0;
  let blanks = 0;
  let blankBytes = 0;
  let busy = false;

  // `at` is how many records of the file the box has read, which starts at the end of the manifest
  // the page was handed: an ordinal is a count of records and a place in the file at once, so the
  // backward walk and the forward one meet there and neither reads what the other has.
  const following = plan.follow;
  const pace = following === null ? 0 : following.every;
  let at = following === null ? 0 : following.from;
  let reaches = plan.bytes;
  let newer = 0;
  let ended = false;
  let misses = 0;
  let beating = 0;
  let every = pace;
  let chasing = false;

  const grab = (from: number, through: number): Promise<Got> =>
    asked(
      plan.file,
      `${plan.path}?file=${encodeURIComponent(plan.file)}&records=${from}.${through}`,
      {},
      `${from}.${through}`,
    );

  const noteFor = (dry: number): string =>
    walkNote({ file: plan.file, bytes: reaches, loaded, shown: list.childElementCount, dry, through: edge <= first });

  const atFoot = (): boolean => box.scrollHeight - box.scrollTop - box.clientHeight < FOOT_SLACK;

  const stopFollowing = (): void => {
    if (beating === 0) return;
    clearTimeout(beating);
    beating = 0;
  };

  const done = (): void => {
    more.remove();
    notes.say(noteFor(0));
  };

  const load = async (): Promise<void> => {
    if (busy || notes.broken()) return;
    if (edge <= first) return done();
    const window = plannedRecords(spans, edge, plan.step);
    if (window.from === window.through) return done();
    busy = true;
    more.setAttribute("disabled", "");
    notes.say(`Reading ${plan.file}…`);

    const got = await grab(window.from, window.through);
    if (!got.ok) {
      busy = false;
      notes.fail(got.why, got.signedOut, () => void load());
      return;
    }
    edge = window.from;
    loaded += window.bytes;

    const held = box.scrollHeight - box.scrollTop;
    const before = list.childElementCount;
    list.insertBefore(rendered(readTurns(got.text, plan.file)), list.firstChild);
    box.scrollTop = box.scrollHeight - held;

    busy = false;
    const blank = list.childElementCount === before;
    blanks = blank ? blanks + 1 : 0;
    blankBytes = blank ? blankBytes + window.bytes : 0;
    if (edge <= first) return done();
    more.removeAttribute("disabled");
    if (blanks >= BLANK_STEPS) {
      const dry = blankBytes;
      blanks = 0;
      blankBytes = 0;
      notes.say(noteFor(dry));
      return;
    }
    notes.say(noteFor(0));
    if (blank) return load();
  };

  const missed = (why: string, signedOut: boolean): void => {
    misses += 1;
    if (misses < FOLLOW_TRIES) return;
    stopFollowing();
    notes.lost(why, signedOut, () => {
      misses = 0;
      every = pace;
      notes.sayTail({ newer, ended });
      startFollowing();
    });
  };

  // One beat. It asks which objects hold records the box has not read, takes as many of them as
  // one step allows, and reads that window forward. The cursor lands on an object boundary every
  // time, so the next beat opens exactly where this one stopped and nothing on screen is fetched
  // a second time.
  const follow = async (): Promise<void> => {
    if (following === null || chasing || notes.adrift()) return;
    chasing = true;
    const got = await asked(
      plan.file,
      `${plan.path}?file=${encodeURIComponent(plan.file)}&since=${at}`,
      {},
      String(at),
    );
    if (!got.ok) {
      chasing = false;
      missed(got.why, got.signedOut);
      return;
    }
    const reach = JSON.parse(got.text) as RecordReach;
    const window = followedRecords(reach.spans, at, plan.step);
    let text = "";
    if (window.through > window.from) {
      const one = await grab(window.from, window.through);
      if (!one.ok) {
        chasing = false;
        missed(one.why, one.signedOut);
        return;
      }
      text = one.text;
    }
    misses = 0;
    at = window.through;
    reaches += window.bytes;
    loaded += window.bytes;
    // A window cut off by its own budget leaves the box behind what the beat already named, so the
    // next beat follows at once rather than waiting out a pace meant for a box that is level.
    const listed = reach.spans[reach.spans.length - 1];
    if (listed !== undefined && at < listed.from + listed.held) every = 0;
    else every = window.bytes > 0 ? pace : Math.min(every * 2, FOLLOW_SLOWEST_MS);

    const foot = atFoot();
    const before = list.childElementCount;
    if (text !== "") list.appendChild(rendered(readTurns(text, plan.file)));
    const added = list.childElementCount - before;
    if (foot) {
      box.scrollTop = box.scrollHeight;
      newer = 0;
    } else {
      newer += added;
    }
    chasing = false;

    if (!reach.running) {
      ended = true;
      stopFollowing();
    }
    if (window.bytes > 0) notes.say(noteFor(0));
    notes.sayTail({ newer, ended });
  };

  const beat = (): void => {
    void follow()
      .catch((error: unknown) => {
        chasing = false;
        missed(`Following ${plan.file} failed: ${error instanceof Error ? error.message : String(error)}.`, false);
      })
      .then(rest);
  };

  const rest = (): void => {
    if (following === null || notes.adrift() || ended || document.hidden) return;
    beating = setTimeout(() => {
      beating = 0;
      beat();
    }, every);
  };

  const startFollowing = (): void => {
    if (following === null || beating !== 0 || chasing || notes.adrift() || ended || document.hidden) return;
    beat();
  };

  more.addEventListener("click", () => {
    void load();
  });
  box.addEventListener("scroll", () => {
    if (box.scrollTop < 240) void load();
    if (newer > 0 && atFoot()) {
      newer = 0;
      notes.sayTail({ newer, ended });
    }
  });

  if (following !== null) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopFollowing();
        return;
      }
      startFollowing();
    });
    window.addEventListener("pagehide", stopFollowing);
  }

  void load().then(() => {
    box.scrollTop = box.scrollHeight;
    startFollowing();
  });
};

const boot = (parts: Parts, plan: Plan): void => {
  if (plan.held === "records") {
    bootRecords(parts, plan);
    return;
  }
  bootBytes(parts, plan);
};

const box = document.getElementById("tx");
const list = document.getElementById("txlist");
const note = document.getElementById("txnote");
const tail = document.getElementById("txtail");
const more = document.getElementById("txmore");
const source = document.getElementById("txplan");
if (box === null || list === null || note === null || tail === null || more === null || source === null) {
  throw new Error("the session page carries no transcript box");
}
boot({ box, list, note, tail, more }, JSON.parse(source.textContent ?? "") as Plan);
