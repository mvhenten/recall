// The browser reads the transcript, not the Worker. The page carries a manifest — every stretch of
// the chosen file, where it sits and how long it is, off one listing — and this script fetches the
// bytes of the stretches it wants off a route that opens one object and streams it. Nothing here
// asks the server where an entry ends or what a window is.
//
// The arithmetic of the walk lives in transcript-plan, and what counts as a turn lives in turns,
// which is the reader the index itself runs. This file is the document and the network around
// them. npm-scripts/build-browser.mjs bundles it to the script served at /transcript.js.

import type { Run } from "../src/transcript-plan";
import {
  type Fetched,
  groupedReads,
  joinedTexts,
  type PlannedRead,
  plannedBatch,
  walkNote,
} from "../src/transcript-plan";
import { readTurns, type Turn } from "../src/turns";

interface Plan {
  path: string;
  file: string;
  bytes: number;
  step: number;
  runs: Run[];
}

// How many batches in a row may come back with no prose in them before the reader stops and says
// so. A transcript is mostly machinery — tool calls, results, file snapshots — and a stretch of
// nothing else would otherwise be walked to the head of the file one fetch at a time on page open.
const BLANK_STEPS = 4;

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

  // A failure holds the box: it stays on screen until the reader asks again, so the next thing the
  // page has to say cannot quietly take its place and leave a reader short of the file with
  // nothing on screen to say so.
  const say = (text: string): void => {
    if (broken) return;
    note.className = "txnote";
    note.textContent = text;
  };

  const answered = async (response: Response, read: PlannedRead): Promise<Got> => {
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
        why: `The archive holds no stretch at ${read.offset} of ${plan.file}, so it and this page disagree about what it holds.`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        signedOut: false,
        why: `Reading ${plan.file} at ${read.offset} failed with ${response.status} ${response.statusText}.`,
      };
    }
    return { ok: true, text: await response.text() };
  };

  const grab = (read: PlannedRead): Promise<Got> => {
    const url = `${plan.path}?file=${encodeURIComponent(plan.file)}&at=${read.offset}`;
    const span = `bytes=${read.skip}-${read.skip + read.bytes - 1}`;
    return fetch(url, { headers: { range: span }, credentials: "same-origin", redirect: "manual" })
      .then((response) => answered(response, read))
      .catch((error: unknown) => ({
        ok: false as const,
        signedOut: false,
        why: `Reading ${plan.file} failed: ${error instanceof Error ? error.message : String(error)}.`,
      }));
  };

  const noteFor = (dry: number): string =>
    walkNote({
      file: plan.file,
      bytes: plan.bytes,
      loaded,
      shown: list.childElementCount,
      dry,
      through: edge === 0,
    });

  const done = (): void => {
    more.remove();
    say(noteFor(0));
  };

  // A read that cannot be had says which read and why, and offers the one control that gets past
  // it: another go at a transport failure, and a reload for a sign-in that has run out, since only
  // a fresh navigation goes back through Access.
  const fail = (why: string, signedOut: boolean): void => {
    broken = true;
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
      void load();
    });
    note.appendChild(again);
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
        fail(got.why, got.signedOut);
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

  more.addEventListener("click", () => {
    void load();
  });
  box.addEventListener("scroll", () => {
    if (box.scrollTop < 240) void load();
  });

  void load().then(() => {
    box.scrollTop = box.scrollHeight;
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
