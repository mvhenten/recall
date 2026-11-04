// The browser reads the transcript, not the Worker. The page carries a manifest — every stretch of
// the chosen file, where it sits and how long it is, off one listing — and this script fetches the
// bytes of the stretches it wants off a route that opens one object and streams it. Nothing here
// asks the server where an entry ends or what a window is.
//
// Two numbers describe where the reader has got to: `edge` is the stretch just older than the
// oldest one loaded, and `pending` is how much of that stretch is still unread. A stretch boundary
// is not a line boundary, so the head of each batch is a part line; it is held back as `remnant`
// and joined to the batch loaded after it, which is the one that holds the rest of that line. A
// run boundary is a hole in the archive, and nothing is joined across one.
export const TRANSCRIPT_SCRIPT = String.raw`
(() => {
  const box = document.getElementById("tx");
  const list = document.getElementById("txlist");
  const note = document.getElementById("txnote");
  const more = document.getElementById("txmore");
  const source = document.getElementById("txplan");
  if (box === null || list === null || note === null || more === null || source === null) return;
  const plan = JSON.parse(source.textContent);

  const reads = [];
  plan.runs.forEach((run, index) => {
    for (const read of run.reads) {
      reads.push({ run: index, offset: read.offset, skip: read.skip, bytes: read.bytes });
    }
  });

  let edge = reads.length;
  let pending = edge === 0 ? 0 : reads[edge - 1].bytes;
  let remnant = "";
  let loaded = 0;
  let busy = false;

  const kb = (bytes) => (bytes < 1024 ? bytes + " B" : Math.round(bytes / 1024) + " kB");

  const say = (text) => {
    note.className = "txnote";
    note.textContent = text;
  };

  const fail = (text) => {
    note.className = "txnote bad";
    note.textContent = text + " ";
    const again = document.createElement("a");
    again.href = location.pathname + location.search;
    again.textContent = "Reload this page";
    note.appendChild(again);
  };

  const ENVELOPES = [
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<system-reminder>",
    "<task-notification>",
  ];

  const spoken = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  };

  const typed = (entry) => {
    if (entry.toolUseResult != null || entry.interruptedMessageId != null) return "";
    if (entry.isMeta === true || entry.isVisibleInTranscriptOnly === true || entry.isCompactSummary === true) return "";
    const prompt = spoken(entry.message && entry.message.content).trim();
    if (prompt === "") return "";
    const kind = entry.origin && entry.origin.kind;
    if (typeof kind === "string") return kind === "human" ? prompt : "";
    return ENVELOPES.some((envelope) => prompt.startsWith(envelope)) ? "" : prompt;
  };

  const stamp = (entry) => {
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
  };

  const turnsOf = (text) => {
    const turns = [];
    for (const line of text.split("\n")) {
      let entry = null;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry === null || typeof entry !== "object" || entry.isSidechain === true) continue;
      if (entry.type === "user") {
        const prompt = typed(entry);
        if (prompt !== "") turns.push({ speaker: "user", text: prompt, at: stamp(entry) });
        continue;
      }
      if (entry.type !== "assistant") continue;
      const said = spoken(entry.message && entry.message.content).trim();
      if (said !== "") turns.push({ speaker: "model", text: said, at: stamp(entry) });
    }
    return turns;
  };

  const rendered = (turns) => {
    const held = document.createDocumentFragment();
    for (const turn of turns) {
      const row = document.createElement("li");
      row.className = "turn " + turn.speaker;
      const who = document.createElement("p");
      who.className = "who";
      const when = turn.at === 0 ? "" : " · " + new Date(turn.at).toISOString().slice(0, 16).replace("T", " ");
      who.textContent = (turn.speaker === "user" ? "you" : "claude") + when;
      const said = document.createElement("pre");
      said.className = "say";
      said.textContent = turn.text;
      row.appendChild(who);
      row.appendChild(said);
      held.appendChild(row);
    }
    return held;
  };

  const answered = async (response, read) => {
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { ok: false, why: "Your dashboard sign-in has ended, so the transcript stopped loading." };
    }
    if (response.status === 404) {
      return {
        ok: false,
        why: "The archive holds no stretch at " + read.offset + " of " + plan.file + ", so it and this page disagree about what it holds.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        why: "Reading " + plan.file + " at " + read.offset + " failed with " + response.status + " " + response.statusText + ".",
      };
    }
    return { ok: true, text: await response.text() };
  };

  const grab = (read) => {
    const url = plan.path + "?file=" + encodeURIComponent(plan.file) + "&at=" + read.offset;
    const span = "bytes=" + read.skip + "-" + (read.skip + read.bytes - 1);
    return fetch(url, { headers: { range: span }, credentials: "same-origin", redirect: "manual" })
      .then((response) => answered(response, read))
      .catch((error) => ({ ok: false, why: "Reading " + plan.file + " failed: " + error.message + "." }));
  };

  const load = async () => {
    if (busy || edge === 0) return;
    busy = true;
    more.disabled = true;
    say("Reading " + plan.file + "…");

    const batch = [];
    let budget = plan.step;
    while (budget > 0 && edge > 0) {
      const read = reads[edge - 1];
      const take = Math.min(pending, budget);
      batch.unshift({ run: read.run, offset: read.offset, skip: read.skip + pending - take, bytes: take });
      budget -= take;
      pending -= take;
      if (pending === 0) {
        edge -= 1;
        pending = edge === 0 ? 0 : reads[edge - 1].bytes;
      }
    }

    const bodies = [];
    for (const read of batch) {
      const got = await grab(read);
      if (!got.ok) {
        fail(got.why);
        more.disabled = false;
        busy = false;
        return;
      }
      bodies.push(got.text);
      loaded += read.bytes;
    }

    const groups = [];
    batch.forEach((read, index) => {
      const last = groups[groups.length - 1];
      if (last !== undefined && last.run === read.run) {
        last.text += bodies[index];
        return;
      }
      groups.push({ run: read.run, at: read.offset + read.skip, text: bodies[index] });
    });

    const held = box.scrollHeight - box.scrollTop;
    const before = list.childElementCount;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      let text = group.text + remnant;
      remnant = "";
      if (group.at > plan.runs[group.run].from) {
        const cut = text.indexOf("\n");
        remnant = cut < 0 ? text : text.slice(0, cut + 1);
        text = cut < 0 ? "" : text.slice(cut + 1);
      }
      list.insertBefore(rendered(turnsOf(text)), list.firstChild);
    }
    box.scrollTop = box.scrollHeight - held;

    busy = false;
    if (edge === 0) {
      more.remove();
      say("The whole of " + plan.file + " is here, " + kb(plan.bytes) + " of it.");
      return;
    }
    more.disabled = false;
    say(kb(loaded) + " of " + kb(plan.bytes) + " read. Scroll up for more.");
    if (list.childElementCount === before) return load();
  };

  more.addEventListener("click", () => {
    load();
  });
  box.addEventListener("scroll", () => {
    if (box.scrollTop < 240) load();
  });

  load().then(() => {
    box.scrollTop = box.scrollHeight;
  });
})();
`;
