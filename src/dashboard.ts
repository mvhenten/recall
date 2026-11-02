import {
  type Focus,
  FRESH_WINDOW_DAYS,
  HISTORY_PARAMS,
  type HistoryInput,
  IDLE_AFTER_MS,
  LIST_PARAMS,
  type ListInput,
  type Live,
  type Memory,
  type MemoryCounts,
  type MemoryHit,
  memoryTypes,
  type PastSession,
  SESSION_HISTORY_DAYS,
  type Session,
  usageDay,
} from "./model";
import { escapeHtml, htmlPage } from "./page";

export interface Tab {
  path: string;
  label: string;
  icon: string;
}

const DISC = '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.6" style="fill:currentColor;stroke:none"/>';
const CLOCK = '<circle cx="10" cy="10" r="7"/><path d="M10 6.2v3.8l2.6 2"/>';
const BOOKMARK = '<path d="M6 3.5h8v13l-4-3.1-4 3.1z"/>';
const BARS = '<path d="M5.5 16V10.5M10 16V5.5M14.5 16V8.5M3.5 16h13"/>';
const SPARK = '<path d="M10 3l1.7 5.1L17 10l-5.3 1.9L10 17l-1.7-5.1L3 10l5.3-1.9z"/>';

export const SESSIONS_TAB: Tab = { path: "/dashboard", label: "Sessions", icon: DISC };
export const HISTORY_TAB: Tab = { path: "/dashboard/history", label: "History", icon: CLOCK };
export const MEMORY_TAB: Tab = { path: "/dashboard/memory", label: "Memory", icon: BOOKMARK };

export const TABS: Tab[] = [
  SESSIONS_TAB,
  HISTORY_TAB,
  MEMORY_TAB,
  { path: "/dashboard/stats", label: "Stats", icon: BARS },
  { path: "/dashboard/insights", label: "Insights", icon: SPARK },
];

const FOCUS_FIRST_CHARS = 80;

export const tabForPath = (pathname: string): Tab | null =>
  TABS.find((tab) => tab.path === pathname.replace(/\/$/, "")) ?? null;

const TOKENS = `:root{color-scheme:light dark;
--bg:#f5f6f8;--surface:#fff;--surface2:#edeff4;
--ink:#171a20;--dim:#5a6373;--faint:#636c7c;
--line:#e2e5eb;--line2:#d2d7e0;
--accent:#3451b2;--on-accent:#fff;
--live:#157a42;--warn:#96670a;
--t-user:#3451b2;--t-project:#157a62;--t-reference:#7a56c9;--t-feedback:#b4541f;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{
--bg:#111318;--surface:#1a1d24;--surface2:#232733;
--ink:#e7eaf0;--dim:#9aa3b2;--faint:#868f9e;
--line:#2a2f3a;--line2:#394050;
--accent:#93aaff;--on-accent:#121419;
--live:#56c988;--warn:#d9a441;
--t-user:#93aaff;--t-project:#45c0a0;--t-reference:#a98ff0;--t-feedback:#e08a4e}}`;

const STYLE = `${TOKENS}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans)}
a{color:var(--accent)}
.app{padding-bottom:4.5rem}
.side{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.7rem 1rem;border-bottom:1px solid var(--line);background:var(--surface)}
.brand{margin:0;display:flex;align-items:center;font:600 .95rem/1 var(--mono);letter-spacing:.02em}
.brand i{flex:none;width:.55rem;height:.55rem;border-radius:2px;background:var(--accent);margin-right:.45rem}
.swho{margin:0;font:400 .72rem/1.4 var(--mono);color:var(--faint);overflow-wrap:anywhere}
.ssum{display:none}
.snav{position:fixed;inset:auto 0 0 0;z-index:1;display:grid;grid-template-columns:repeat(5,1fr);border-top:1px solid var(--line);background:var(--surface)}
.snav a{display:grid;gap:.18rem;justify-items:center;padding:.5rem .15rem .55rem;font-size:.62rem;letter-spacing:.02em;color:var(--dim);text-decoration:none}
.snav a svg{width:1.25rem;height:1.25rem;stroke:currentcolor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.snav a[aria-current]{color:var(--accent);font-weight:600}
.snav a:focus-visible,.find :focus-visible,.chips a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
main{padding:1rem;display:grid;gap:.7rem;align-content:start}
.pagehead{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.pagehead h1{margin:0;font-size:1.05rem;letter-spacing:-.01em;overflow-wrap:anywhere}
.pagehead span{font:400 .76rem/1 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{display:grid;gap:.3rem;padding:1.4rem .2rem}
.empty b{font-size:.92rem;font-weight:600}
.empty p{margin:0;font-size:.85rem;color:var(--dim);max-width:46ch}
.rail{display:none}
.sessions,.memories{list-style:none;margin:0;padding:0;display:grid;gap:.7rem}
.srow{display:grid;gap:.3rem;padding:.8rem .9rem;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.srow p{margin:0}
.lhead{display:none}
.h{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap;overflow-wrap:anywhere}
.h b{font:600 .9rem/1.3 var(--mono)}
.host{font:400 .72rem/1 var(--mono);color:var(--faint)}
.state{display:flex;align-items:center;gap:.45rem;font-size:.78rem;color:var(--dim)}
.dot{flex:none;width:.5rem;height:.5rem;border-radius:50%;background:currentcolor}
.idle .dot{background:transparent;box-shadow:inset 0 0 0 1.5px currentcolor}
.busy{color:var(--live);font-weight:600}
.busy .dot{animation:beat 2s ease-in-out infinite}
@keyframes beat{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.busy .dot{animation:none}}
.fc{font-size:.88rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.then{color:var(--faint)}
.smeta{display:flex;flex-wrap:wrap;gap:.35rem;font:400 .74rem/1.5 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.smeta>*+*::before{content:"· "}
.hist{display:grid;gap:1.1rem;align-items:start}
.day{display:grid;gap:.6rem;align-content:start}
.dayhead{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin:0;padding:.5rem .15rem;border-bottom:2px solid var(--line2)}
.dayhead b{font:600 .78rem/1 var(--mono);letter-spacing:.1em}
.dayhead span{font:400 .74rem/1 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
.tm{font:400 .74rem/1.4 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
.run{font:600 .7rem/1 var(--mono);color:var(--live)}
.mcard{display:grid;gap:.45rem;padding:.85rem .95rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;align-content:start}
.mcard p{margin:0}
.mh{display:flex;align-items:center;justify-content:space-between;gap:.6rem}
.mh a{font:600 .88rem/1.3 var(--mono);overflow-wrap:anywhere}
.mtype{display:inline-flex;align-items:center;gap:.35rem;font:600 .64rem/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--dim);white-space:nowrap}
.mtype i{flex:none;width:.45rem;height:.45rem;border-radius:50%}
.mt-user i{background:var(--t-user)}
.mt-project i{background:var(--t-project)}
.mt-reference i{background:var(--t-reference)}
.mt-feedback i{background:var(--t-feedback)}
.md{font-size:.85rem;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.tags{display:flex;flex-wrap:wrap;gap:.3rem}
.tags span{font:400 .68rem/1 var(--mono);color:var(--dim);background:var(--surface2);border-radius:4px;padding:.25rem .4rem;overflow-wrap:anywhere}
.mfoot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.6rem;font:400 .7rem/1.4 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
.mfoot .never{color:var(--warn);font-weight:600}
.toolrow{display:flex;gap:.9rem;align-items:center;flex-wrap:wrap}
.find{display:flex;gap:.5rem;flex:1;min-width:0;max-width:30rem;margin:0}
.find input{flex:1 1 7rem;font:inherit;font-size:.9rem;padding:.5rem .75rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink);min-width:0}
.find input::placeholder{color:var(--faint)}
.find button{font:600 .85rem/1 var(--sans);padding:.5rem .9rem;border:0;border-radius:6px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.chips{display:flex;gap:.4rem;flex-wrap:nowrap;overflow-x:auto;padding-bottom:.2rem}
.chips a{font:400 .74rem/1 var(--mono);color:var(--dim);text-decoration:none;white-space:nowrap;padding:.35rem .55rem;border:1px solid var(--line2);border-radius:999px;background:var(--surface)}
.chips a[aria-current]{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.strip{list-style:none;display:flex;flex-wrap:wrap;gap:.3rem .9rem;margin:0;padding:0;font:400 .74rem/1.5 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
.strip strong{color:var(--ink);font-weight:600}
.more{margin:.4rem 0 0;font-size:.85rem}
.lede{margin:0;font-size:.95rem;color:var(--dim);max-width:70ch}
.body{margin:0;padding:1rem 1.1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;font:400 .82rem/1.65 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.noticewrap{max-width:34rem;margin:0 auto;padding:3rem 1.25rem;display:grid;gap:1.1rem}
.notice{display:grid;gap:.45rem;padding:1rem 1.1rem;background:var(--surface);border:1px solid var(--line2);border-left:3px solid var(--warn);border-radius:8px}
.notice h1{margin:0;font-size:.92rem}
.notice p{margin:0;font-size:.85rem;color:var(--dim)}
.notice a{font-size:.85rem;font-weight:600}
.notice a::after{content:" \\2192"}
@media (min-width:64rem){
.app{display:grid;grid-template-columns:14.5rem minmax(0,1fr);align-items:start;padding-bottom:0}
.side{position:sticky;top:0;height:100vh;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:1.1rem;padding:1rem .8rem;border-bottom:0;border-right:1px solid var(--line)}
.brand{font-size:1rem;padding:.3rem .55rem}
.brand i{width:.6rem;height:.6rem;margin-right:.5rem}
.snav{position:static;grid-template-columns:minmax(0,1fr);gap:.2rem;border-top:0;background:none}
.snav a{display:flex;align-items:center;gap:.65rem;padding:.55rem .65rem .55rem .55rem;border-left:3px solid transparent;border-radius:0 6px 6px 0;font-size:.9rem;letter-spacing:0}
.snav a svg{flex:none;width:1.15rem;height:1.15rem}
.snav a[aria-current]{border-left-color:var(--accent);background:var(--surface2);color:var(--ink)}
.snav a:focus-visible{outline-offset:2px}
.ssum{display:grid;gap:.45rem;margin-top:auto;padding:.9rem .55rem 0;border-top:1px solid var(--line)}
.ssum b{font:600 .62rem/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}
.ssum p{margin:0;font:400 .78rem/1.5 var(--mono);color:var(--dim);font-variant-numeric:tabular-nums}
.ssum p strong{color:var(--ink);font-weight:600}
.livedot{display:inline-block;width:.45rem;height:.45rem;border-radius:50%;background:var(--live);margin-right:.35rem}
.swho{padding:0 .55rem}
main{padding:1.1rem 1.5rem 1.5rem;gap:.9rem}
.pagehead h1{font-size:1.2rem}
.withrail{display:grid;grid-template-columns:minmax(0,1fr) 19rem;gap:1rem;align-items:start}
.rail{display:grid;gap:1rem;align-content:start}
.rk{display:grid;gap:.55rem;padding:.9rem 1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.rk b{font:600 .64rem/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}
.rk p{margin:0;font-size:.82rem;color:var(--dim)}
.rk p strong{color:var(--ink);font-family:var(--mono);font-weight:600}
.sessions{gap:0;background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.srow{grid-template-columns:7.5rem 9rem 16rem minmax(0,1fr) 4.5rem 6rem;gap:1rem;align-items:center;padding:.5rem 1rem;border:0;border-bottom:1px solid var(--line);border-radius:0;background:none}
.sessions>:last-child{border-bottom:0}
.lhead{display:grid;font:600 .66rem/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--faint);background:var(--surface2);padding:.55rem 1rem}
.srow .state{grid-area:1/1}
.srow .h{grid-area:1/2}
.srow .fc{grid-area:1/4;-webkit-line-clamp:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.85rem}
.srow .host{display:none}
.srow .h b{font-size:.84rem}
.smeta{display:contents}
.smeta>*+*::before{content:none}
.rp{grid-area:1/3;font:400 .8rem/1.3 var(--mono);color:var(--dim);overflow-wrap:anywhere}
.ag{grid-area:1/5}
.pr{grid-area:1/6}
.ag,.pr{font:400 .8rem/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--dim);text-align:right}
.lhead .r{text-align:right}
.unit{display:none}
.hist{grid-template-columns:1fr 1fr;gap:1.2rem 1rem}
.hrow{grid-template-columns:8.5rem 9rem 14rem minmax(0,1fr) 4.5rem 5.5rem}
.hrow .tm{grid-area:1/1}
.memories{grid-template-columns:repeat(auto-fill,minmax(18rem,1fr));gap:1rem}
.chips{flex-wrap:wrap;overflow-x:visible}
}`;

const navigation = (current: Tab): string =>
  `<nav class="snav" aria-label="Dashboard">${TABS.map(
    (tab) =>
      `<a href="${tab.path}"${tab === current ? ' aria-current="page"' : ""}><svg viewBox="0 0 20 20" aria-hidden="true">${tab.icon}</svg>${escapeHtml(tab.label)}</a>`,
  ).join("")}</nav>`;

// repoAtBranch, age and focusHtml port markdown::repo_at_branch, sessions::age and
// sessions::focus_line from cli/src, so a browser reads a session the way a terminal does.
const repoAtBranch = (repo: string, branch: string): string => {
  if (repo === "") return "global";
  return branch === "" ? repo : `${repo}@${branch}`;
};

const age = (since: number, now: number): string => {
  const seconds = Math.floor(Math.max(0, now - since) / 1000);
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ] as const) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
  }
  return `${seconds}s`;
};

const shorten = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;

const focusHtml = (focus: Focus): string => {
  if (focus.first === "") return escapeHtml(focus.latest);
  if (focus.latest === "" || focus.latest === focus.first) return escapeHtml(focus.first);
  return `${escapeHtml(shorten(focus.first, FOCUS_FIRST_CHARS))}<span class="then"> → </span>${escapeHtml(focus.latest)}`;
};

const isBusy = (session: Session, now: number): boolean => now - session.lastActivityAt < IDLE_AFTER_MS;

const emptyState = (headline: string, hint: string): string =>
  `<div class="empty"><b>${escapeHtml(headline)}</b><p>${escapeHtml(hint)}</p></div>`;

const summary = (live: Live): string => {
  const dot = live.busy === 0 ? "" : '<span class="livedot"></span>';
  return `<div class="ssum"><b>Now</b><p>${dot}<strong>${live.busy} busy</strong> · ${live.sessions} live</p></div>`;
};

const shell = (email: string, tab: Tab, live: Live, heading: string, meta: string, main: string): Response =>
  htmlPage(
    200,
    `recall ${heading.toLowerCase()}`,
    STYLE,
    `<div class="app"><header class="side"><p class="brand"><i></i>recall</p>
${navigation(tab)}
${summary(live)}
<p class="swho">${escapeHtml(email)}</p></header>
<main><div class="pagehead"><h1>${escapeHtml(heading)}</h1><span>${escapeHtml(meta)}</span></div>${main}</main></div>`,
  );

export const dashboardPage = (email: string, tab: Tab, live: Live): Response =>
  shell(email, tab, live, tab.label, "", emptyState("Nothing to show here yet.", "This page is still being built."));

const sessionRow = (session: Session, now: number): string => {
  const busy = isBusy(session, now);
  const state = busy ? "busy" : `idle ${age(session.lastActivityAt, now)}`;
  const focus = focusHtml(session.focus);
  return `<li class="srow${busy ? "" : " idle"}"><p class="h"><b>${escapeHtml(session.name)}</b> <span class="host">${escapeHtml(session.host)}</span></p>
<p class="${busy ? "state busy" : "state"}"><span class="dot"></span>${state}</p>
<p class="fc">${focus}</p>
<p class="smeta"><span class="rp">${escapeHtml(repoAtBranch(session.repo, session.branch))}</span><span class="ag">${age(session.startedAt, now)}</span><span class="pr">${session.prompts}<span class="unit"> ${session.prompts === 1 ? "prompt" : "prompts"}</span></span></p></li>`;
};

const LEDGER_HEAD =
  '<li class="srow lhead" aria-hidden="true"><span>State</span><span>Session</span><span>Repo</span><span>Focus</span><span class="r">Age</span><span class="r">Prompts</span></li>';

// listSessions answers newest activity first, which already floats every busy session above the
// idle ones.
const ledger = (sessions: Session[], now: number): string =>
  `<ol class="sessions" role="list">${LEDGER_HEAD}${sessions.map((session) => sessionRow(session, now)).join("")}</ol>`;

const hostsCard = (sessions: Session[], now: number): string => {
  const hosts = new Map<string, { live: number; busy: number }>();
  for (const session of sessions) {
    const tally = hosts.get(session.host) ?? { live: 0, busy: 0 };
    hosts.set(session.host, { live: tally.live + 1, busy: tally.busy + (isBusy(session, now) ? 1 : 0) });
  }
  const lines = [...hosts]
    .map(
      ([host, tally]) =>
        `<p><strong>${escapeHtml(host)}</strong> · ${tally.live} ${tally.live === 1 ? "session" : "sessions"} · ${tally.busy} busy</p>`,
    )
    .join("");
  return `<div class="rk"><b>Hosts</b>${lines}</div>`;
};

const oldestIdleCard = (sessions: Session[], now: number): string => {
  const idle = sessions.filter((session) => !isBusy(session, now));
  const oldest = idle[idle.length - 1];
  if (!oldest) return "";
  return `<div class="rk"><b>Oldest idle</b><p><strong>${escapeHtml(oldest.name)}</strong> · idle ${age(oldest.lastActivityAt, now)} on ${escapeHtml(repoAtBranch(oldest.repo, oldest.branch))}</p><p>Started ${age(oldest.startedAt, now)} ago · ${oldest.prompts} ${oldest.prompts === 1 ? "prompt" : "prompts"}.</p></div>`;
};

export const sessionsPage = (email: string, live: Live, sessions: Session[], now: number): Response => {
  const main =
    sessions.length === 0
      ? emptyState(
          "No session is running on any of your hosts.",
          "A session appears here within a minute of its first prompt.",
        )
      : `<div class="withrail">${ledger(sessions, now)}<div class="rail">${hostsCard(sessions, now)}${oldestIdleCard(sessions, now)}</div></div>`;
  return shell(email, SESSIONS_TAB, live, SESSIONS_TAB.label, `${live.sessions} live · ${live.busy} busy`, main);
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// session_history keeps epoch milliseconds and usage_daily rolls up on the UTC day, so the history
// reads the clock and the day in UTC too and the two pages never disagree about which day a session
// belongs to.
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

const span = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
};

interface DayGroup {
  day: string;
  sessions: PastSession[];
}

const byDay = (sessions: PastSession[]): DayGroup[] => {
  const groups: DayGroup[] = [];
  for (const session of sessions) {
    const day = usageDay(session.lastActivityAt);
    const open = groups.at(-1);
    if (open?.day === day) open.sessions.push(session);
    else groups.push({ day, sessions: [session] });
  }
  return groups;
};

const dayHead = (group: DayGroup): string => {
  const count = group.sessions.length;
  const worked = group.sessions.reduce((total, session) => total + (session.lastActivityAt - session.startedAt), 0);
  const weekday = WEEKDAYS[new Date(`${group.day}T00:00:00Z`).getUTCDay()] ?? "";
  return `<p class="dayhead"><b>${escapeHtml(group.day)} · ${weekday}</b><span>${count} ${count === 1 ? "session" : "sessions"} · ${span(worked)}</span></p>`;
};

const historyRow = (session: PastSession, running: boolean): string =>
  `<li class="srow hrow"><p class="tm">${clock(session.startedAt)}–${clock(session.lastActivityAt)}</p>
<p class="h"><b>${escapeHtml(session.name)}</b> <span class="host">${escapeHtml(session.host)}</span>${running ? ' <span class="run">running</span>' : ""}</p>
<p class="fc">${focusHtml(session.focus)}</p>
<p class="smeta"><span class="rp">${escapeHtml(repoAtBranch(session.repo, session.branch))}</span><span class="ag">${span(session.lastActivityAt - session.startedAt)}</span><span class="pr">${session.prompts}<span class="unit"> ${session.prompts === 1 ? "prompt" : "prompts"}</span></span></p></li>`;

const dayBlock = (group: DayGroup, running: Set<string>): string =>
  `<section class="day">${dayHead(group)}<ol class="sessions" role="list">${group.sessions
    .map((session) => historyRow(session, running.has(session.sessionId)))
    .join("")}</ol></section>`;

const historyLink = (url: URL, changes: Record<string, string>): string => {
  const next = new URLSearchParams();
  for (const name of HISTORY_PARAMS) {
    const value = url.searchParams.get(name) ?? "";
    if (value !== "") next.set(name, value);
  }
  for (const [name, value] of Object.entries(changes)) {
    if (value === "") next.delete(name);
    else next.set(name, value);
  }
  const query = next.toString();
  return escapeHtml(query === "" ? HISTORY_TAB.path : `${HISTORY_TAB.path}?${query}`);
};

const historyChips = (url: URL, name: string, label: string, all: string, active: string, values: string[]): string => {
  const chip = (value: string, text: string): string =>
    `<a href="${historyLink(url, { [name]: value })}"${value === active ? ' aria-current="page"' : ""}>${escapeHtml(text)}</a>`;
  return `<nav class="chips" aria-label="${escapeHtml(label)}">${chip("", all)}${values.map((value) => chip(value, value)).join("")}</nav>`;
};

const offered = (values: string[], active: string): string[] => {
  const present = new Set(values.filter((value) => value !== ""));
  if (active !== "") present.add(active);
  return [...present].sort();
};

export const historyPage = (
  email: string,
  live: Live,
  url: URL,
  filter: HistoryInput,
  sessions: PastSession[],
  running: Set<string>,
  nextCursor: string,
): Response => {
  const filtered = filter.host !== "" || filter.repo !== "";
  const groups = byDay(sessions);
  const older =
    nextCursor === ""
      ? ""
      : `<p class="more"><a href="${historyLink(url, { cursor: nextCursor })}">Older sessions</a></p>`;
  const listing =
    groups.length === 0
      ? emptyState(
          filtered ? "No session matches this filter." : "No session is in your history yet.",
          filtered
            ? "Clear the filter to read every host and every repo."
            : `A session lands here as soon as it syncs, and stays for ${SESSION_HISTORY_DAYS} days.`,
        )
      : `<div class="hist">${groups.map((group) => dayBlock(group, running)).join("")}</div>${older}`;
  const filters = `<div class="toolrow">${historyChips(
    url,
    "host",
    "Filter by host",
    "All hosts",
    filter.host,
    offered(
      sessions.map((session) => session.host),
      filter.host,
    ),
  )}${historyChips(
    url,
    "repo",
    "Filter by repo",
    "All repos",
    filter.repo,
    offered(
      sessions.map((session) => session.repo),
      filter.repo,
    ),
  )}</div>`;
  return shell(
    email,
    HISTORY_TAB,
    live,
    HISTORY_TAB.label,
    `last ${SESSION_HISTORY_DAYS} days`,
    `${filters}${listing}`,
  );
};

const memoryLink = (url: URL, changes: Record<string, string>): string => {
  const next = new URLSearchParams();
  for (const name of ["q", ...LIST_PARAMS]) {
    const value = url.searchParams.get(name) ?? "";
    if (value !== "") next.set(name, value);
  }
  for (const [name, value] of Object.entries(changes)) {
    if (value === "") next.delete(name);
    else next.set(name, value);
  }
  const query = next.toString();
  return escapeHtml(query === "" ? MEMORY_TAB.path : `${MEMORY_TAB.path}?${query}`);
};

const findForm = (url: URL, filter: ListInput): string => {
  const type = filter.types[0] ?? "";
  const keepType = type === "" ? "" : `<input type="hidden" name="type" value="${escapeHtml(type)}">`;
  return `<form class="find" method="get" action="${MEMORY_TAB.path}">
<input type="search" name="q" value="${escapeHtml(url.searchParams.get("q") ?? "")}" placeholder="Search memories…" aria-label="Search memories">
<input name="tag" value="${escapeHtml(filter.tags[0] ?? "")}" placeholder="tag" aria-label="Filter by tag">${keepType}
<button type="submit">Search</button></form>`;
};

const typeChips = (url: URL, filter: ListInput, counts: MemoryCounts): string => {
  const active = filter.types[0] ?? "";
  const counted = new Map(counts.byType.map((entry) => [entry.type, entry.count]));
  const chip = (type: string, label: string): string =>
    `<a href="${memoryLink(url, { type })}"${type === active ? ' aria-current="page"' : ""}>${label}</a>`;
  const present = memoryTypes.filter((type) => counted.has(type) || type === active);
  return `<nav class="chips" aria-label="Filter by type">${chip("", `All ${counts.total}`)}${present
    .map((type) => chip(type, `${type} ${counted.get(type) ?? 0}`))
    .join("")}</nav>`;
};

const countsStrip = (counts: MemoryCounts): string => {
  const cells = [
    `<strong>${counts.recalled}</strong> recalled`,
    `<strong>${counts.total - counts.recalled}</strong> never recalled`,
    `<strong>${counts.fresh}</strong> new in ${FRESH_WINDOW_DAYS} days`,
  ];
  return `<ul class="strip" role="list">${cells.map((cell) => `<li>${cell}</li>`).join("")}</ul>`;
};

const recalls = (memory: Memory, now: number): string =>
  memory.recallCount === 0
    ? "never recalled"
    : `recalled ${memory.recallCount}×, last ${age(memory.lastRecalledAt, now)} ago`;

const recallFoot = (memory: Memory, now: number): string =>
  memory.recallCount === 0
    ? '<span class="never">never recalled</span>'
    : `<span>${memory.recallCount} ${memory.recallCount === 1 ? "recall" : "recalls"}</span><span>last ${age(memory.lastRecalledAt, now)} ago</span>`;

const memoryCard = (memory: Memory, now: number, score: string): string => {
  const tags = memory.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const scored = score === "" ? "" : `<span>score ${score}</span>`;
  return `<li class="mcard"><p class="mh"><a href="${MEMORY_TAB.path}/${encodeURIComponent(memory.name)}">${escapeHtml(memory.name)}</a><span class="mtype mt-${memory.type}"><i></i>${memory.type}</span></p>
<p class="md">${escapeHtml(memory.description)}</p>
${tags === "" ? "" : `<p class="tags">${tags}</p>`}
<p class="mfoot">${recallFoot(memory, now)}${scored}</p></li>`;
};

const memoryGrid = (cards: string[], headline: string, hint: string): string =>
  cards.length === 0 ? emptyState(headline, hint) : `<ol class="memories" role="list">${cards.join("")}</ol>`;

const memoryTotal = (counts: MemoryCounts): string => `${counts.total} ${counts.total === 1 ? "memory" : "memories"}`;

const memoryMain = (url: URL, filter: ListInput, counts: MemoryCounts, grid: string, older: string): string =>
  `<div class="toolrow">${findForm(url, filter)}${typeChips(url, filter, counts)}</div>${countsStrip(counts)}${grid}${older}`;

export const memoriesPage = (
  email: string,
  live: Live,
  url: URL,
  filter: ListInput,
  counts: MemoryCounts,
  memories: Memory[],
  nextCursor: string,
  now: number,
): Response => {
  const older =
    nextCursor === ""
      ? ""
      : `<p class="more"><a href="${memoryLink(url, { cursor: nextCursor })}">Older memories</a></p>`;
  const grid = memoryGrid(
    memories.map((memory) => memoryCard(memory, now, "")),
    "No memory is saved yet.",
    "Save one with recall save.",
  );
  return shell(
    email,
    MEMORY_TAB,
    live,
    MEMORY_TAB.label,
    memoryTotal(counts),
    memoryMain(url, filter, counts, grid, older),
  );
};

export const memorySearchPage = (
  email: string,
  live: Live,
  url: URL,
  filter: ListInput,
  counts: MemoryCounts,
  hits: MemoryHit[],
  now: number,
): Response => {
  const grid = memoryGrid(
    hits.map((hit) => memoryCard(hit.memory, now, hit.score.toFixed(3))),
    "No memory matches this search.",
    "Try fewer words, or drop the type filter.",
  );
  return shell(
    email,
    MEMORY_TAB,
    live,
    MEMORY_TAB.label,
    memoryTotal(counts),
    memoryMain(url, filter, counts, grid, ""),
  );
};

export const memoryBodyPage = (email: string, live: Live, memory: Memory, now: number): Response => {
  const meta = [memory.type, ...memory.tags, recalls(memory, now), `saved ${age(memory.createdAt, now)} ago`];
  return shell(
    email,
    MEMORY_TAB,
    live,
    memory.name,
    `${memory.type} · saved ${age(memory.createdAt, now)} ago`,
    `<p class="strip">${escapeHtml(meta.join(" · "))}</p>
<p class="lede">${escapeHtml(memory.description)}</p>
<pre class="body">${escapeHtml(memory.body)}</pre>
<p class="more"><a href="${MEMORY_TAB.path}">Back to memories</a></p>`,
  );
};

export const dashboardNotice = (status: number, title: string, text: string, action: string): Response =>
  htmlPage(
    status,
    `recall ${title.toLowerCase()}`,
    STYLE,
    `<main class="noticewrap"><p class="brand"><i></i>recall</p>
<div class="notice"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><a href="/dashboard">${escapeHtml(action)}</a></div></main>`,
  );
