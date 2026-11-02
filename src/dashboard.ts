import {
  type Focus,
  FRESH_WINDOW_MS,
  IDLE_AFTER_MS,
  type Memory,
  type MemoryCounts,
  type MemoryHit,
  memoryTypes,
  type Session,
} from "./model";
import { escapeHtml, htmlPage } from "./page";

export interface Tab {
  path: string;
  label: string;
}

export const SESSIONS_TAB: Tab = { path: "/dashboard", label: "Sessions" };
export const MEMORY_TAB: Tab = { path: "/dashboard/memory", label: "Memory" };

export const TABS: Tab[] = [
  SESSIONS_TAB,
  MEMORY_TAB,
  { path: "/dashboard/stats", label: "Stats" },
  { path: "/dashboard/insights", label: "Insights" },
];

export interface MemoryFilters {
  query: string;
  tag: string;
  type: string;
}

const PLACEHOLDER = "Nothing to show here yet.";
const NO_SESSIONS = "No session is running on any of your hosts.";
const NO_MEMORIES = "No memory is saved yet. Save one with recall save.";
const NO_MATCHES = "No memory matches this search.";
const FOCUS_FIRST_CHARS = 80;
const FRESH_WINDOW_DAYS = FRESH_WINDOW_MS / 86_400_000;

export const tabForPath = (pathname: string): Tab | null =>
  TABS.find((tab) => tab.path === pathname.replace(/\/$/, "")) ?? null;

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--ink:#1a1a1a;--dim:#5c5c66;--line:#e3e3e8;--accent:#2b53c8;--live:#1a7f45}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--ink:#ededf2;--dim:#9b9ba6;--line:#2b2b33;--accent:#92b2ff;--live:#5fd08a}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--ink);background:var(--bg);padding-bottom:4.5rem}
.bar{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;padding:.9rem 1rem;border-bottom:1px solid var(--line)}
.bar h1{margin:0;font-size:1.05rem;letter-spacing:.04em}
.who{margin:0;font-size:.8rem;color:var(--dim);overflow-wrap:anywhere}
.tabs{position:fixed;inset:auto 0 0 0;display:grid;grid-template-columns:repeat(4,1fr);background:var(--bg);border-top:1px solid var(--line)}
.tabs a{padding:.85rem .25rem;text-align:center;font-size:.8rem;color:var(--dim);text-decoration:none}
.tabs a[aria-current]{color:var(--accent);box-shadow:inset 0 2px 0 var(--accent)}
main{max-width:60rem;margin:0 auto;padding:1rem}
main h2{margin:0 0 .9rem;font-size:1.35rem}
main a{color:var(--accent)}
.empty{margin:0;color:var(--dim)}
.feed{list-style:none;margin:0;padding:0;display:grid;gap:.7rem}
.card{display:grid;gap:.3rem;padding:.75rem .85rem;border:1px solid var(--line);border-radius:.6rem}
.card p{margin:0}
.handle{display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;font-weight:600;overflow-wrap:anywhere}
.host{font-weight:400;font-size:.8rem;color:var(--dim)}
.state{display:flex;align-items:center;gap:.4rem;font-size:.8rem;color:var(--dim)}
.dot{flex:none;width:.5rem;height:.5rem;border-radius:50%;background:currentcolor}
.busy{color:var(--live)}
.busy .dot{animation:beat 2s ease-in-out infinite}
@keyframes beat{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.busy .dot{animation:none}}
.focus{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.then{color:var(--dim)}
.meta{font-size:.8rem;color:var(--dim);overflow-wrap:anywhere}
.find{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 .9rem}
.find input,.find select,.find button{font:inherit;font-size:.9rem;padding:.45rem .6rem;border:1px solid var(--line);border-radius:.4rem;background:var(--bg);color:var(--ink);min-width:0}
.find input[type=search]{flex:1 1 12rem}
.find input[name=tag]{flex:1 1 7rem}
.find button{color:var(--accent);cursor:pointer}
.strip{list-style:none;display:flex;flex-wrap:wrap;gap:.3rem .9rem;margin:0 0 .9rem;padding:0;font-size:.8rem;color:var(--dim)}
.strip strong{color:var(--ink);font-weight:600}
.body{margin:.9rem 0 0;padding:.75rem .85rem;border:1px solid var(--line);border-radius:.6rem;font:.9rem/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.lede{margin:0}
.more{margin:.9rem 0 0;font-size:.9rem}
@media (min-width:48rem){
body{padding-bottom:0}
.tabs{position:static;max-width:60rem;margin:0 auto;grid-template-columns:repeat(4,max-content);border-top:0;border-bottom:1px solid var(--line)}
.tabs a{padding:.7rem 1.1rem;font-size:.95rem}
.feed{gap:.4rem}
.card{grid-template-columns:minmax(8rem,max-content) 6.5rem minmax(0,1fr);align-items:baseline;gap:.2rem 1rem;border-radius:.4rem}
.focus{-webkit-line-clamp:1}
.meta{grid-column:3}
.memories .card{grid-template-columns:minmax(10rem,max-content) minmax(0,1fr)}
.memories .meta{grid-column:2}
}`;

const navigation = (current: Tab): string =>
  `<nav class="tabs" aria-label="Dashboard">${TABS.map(
    (tab) => `<a href="${tab.path}"${tab === current ? ' aria-current="page"' : ""}>${escapeHtml(tab.label)}</a>`,
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

const card = (session: Session, now: number): string => {
  const busy = now - session.lastActivityAt < IDLE_AFTER_MS;
  const state = busy ? "busy" : `idle ${age(session.lastActivityAt, now)}`;
  const focus = focusHtml(session.focus);
  const meta = [
    repoAtBranch(session.repo, session.branch),
    age(session.startedAt, now),
    `${session.prompts} ${session.prompts === 1 ? "prompt" : "prompts"}`,
  ];
  return `<li class="card"><p class="handle">${escapeHtml(session.name)} <span class="host">${escapeHtml(session.host)}</span></p>
<p class="${busy ? "state busy" : "state"}"><span class="dot"></span>${state}</p>
${focus === "" ? "" : `<p class="focus">${focus}</p>`}
<p class="meta">${meta.map(escapeHtml).join(" · ")}</p></li>`;
};

// listSessions answers newest activity first, which already floats every busy session above the
// idle ones.
const feed = (sessions: Session[], now: number): string =>
  sessions.length === 0
    ? `<p class="empty">${NO_SESSIONS}</p>`
    : `<ol class="feed" role="list">${sessions.map((session) => card(session, now)).join("")}</ol>`;

const shell = (email: string, tab: Tab, heading: string, main: string): Response =>
  htmlPage(
    200,
    `recall ${heading.toLowerCase()}`,
    STYLE,
    `<header class="bar"><h1>recall</h1><p class="who">${escapeHtml(email)}</p></header>
${navigation(tab)}
<main><h2>${escapeHtml(heading)}</h2>${main}</main>`,
  );

export const dashboardPage = (email: string, tab: Tab): Response =>
  shell(email, tab, tab.label, `<p class="empty">${PLACEHOLDER}</p>`);

export const sessionsPage = (email: string, sessions: Session[], now: number): Response =>
  shell(email, SESSIONS_TAB, SESSIONS_TAB.label, feed(sessions, now));

const link = (params: Array<[string, string]>): string => {
  const search = new URLSearchParams(params.filter(([, value]) => value !== "")).toString();
  return escapeHtml(search === "" ? MEMORY_TAB.path : `${MEMORY_TAB.path}?${search}`);
};

const findForm = (filters: MemoryFilters): string =>
  `<form class="find" method="get" action="${MEMORY_TAB.path}">
<input type="search" name="q" value="${escapeHtml(filters.query)}" placeholder="Search memories" aria-label="Search memories">
<input name="tag" value="${escapeHtml(filters.tag)}" placeholder="tag" aria-label="Filter by tag">
<select name="type" aria-label="Filter by type"><option value="">any type</option>${memoryTypes
    .map((type) => `<option value="${type}"${type === filters.type ? " selected" : ""}>${type}</option>`)
    .join("")}</select>
<button type="submit">Find</button></form>`;

const countsStrip = (counts: MemoryCounts): string => {
  const cells = [
    `<strong>${counts.total}</strong> ${counts.total === 1 ? "memory" : "memories"}`,
    `<strong>${counts.recalled}</strong> recalled`,
    `<strong>${counts.total - counts.recalled}</strong> never recalled`,
    `<strong>${counts.fresh}</strong> new in ${FRESH_WINDOW_DAYS} days`,
    ...counts.byType.map((entry) => `${escapeHtml(entry.type)} <strong>${entry.count}</strong>`),
  ];
  return `<ul class="strip" role="list">${cells.map((cell) => `<li>${cell}</li>`).join("")}</ul>`;
};

const recalls = (memory: Memory, now: number): string =>
  memory.recallCount === 0
    ? "never recalled"
    : `recalled ${memory.recallCount}×, last ${age(memory.lastRecalledAt, now)} ago`;

const memoryCard = (memory: Memory, now: number, score: string): string => {
  const meta = [...memory.tags, recalls(memory, now), ...(score === "" ? [] : [`score ${score}`])];
  return `<li class="card"><p class="handle"><a href="${MEMORY_TAB.path}/${encodeURIComponent(memory.name)}">${escapeHtml(memory.name)}</a> <span class="host">${escapeHtml(memory.type)}</span></p>
<p class="focus">${escapeHtml(memory.description)}</p>
<p class="meta">${meta.map(escapeHtml).join(" · ")}</p></li>`;
};

const memoryFeed = (cards: string[], empty: string): string =>
  cards.length === 0 ? `<p class="empty">${empty}</p>` : `<ol class="feed memories" role="list">${cards.join("")}</ol>`;

export const memoriesPage = (
  email: string,
  filters: MemoryFilters,
  counts: MemoryCounts,
  memories: Memory[],
  nextCursor: string,
  now: number,
): Response => {
  const older =
    nextCursor === ""
      ? ""
      : `<p class="more"><a href="${link([
          ["tag", filters.tag],
          ["type", filters.type],
          ["cursor", nextCursor],
        ])}">Older memories</a></p>`;
  return shell(
    email,
    MEMORY_TAB,
    MEMORY_TAB.label,
    `${findForm(filters)}${countsStrip(counts)}${memoryFeed(
      memories.map((memory) => memoryCard(memory, now, "")),
      NO_MEMORIES,
    )}${older}`,
  );
};

export const memorySearchPage = (
  email: string,
  filters: MemoryFilters,
  counts: MemoryCounts,
  hits: MemoryHit[],
  now: number,
): Response =>
  shell(
    email,
    MEMORY_TAB,
    MEMORY_TAB.label,
    `${findForm(filters)}${countsStrip(counts)}${memoryFeed(
      hits.map((hit) => memoryCard(hit.memory, now, hit.score.toFixed(3))),
      NO_MATCHES,
    )}`,
  );

export const memoryBodyPage = (email: string, memory: Memory, now: number): Response => {
  const meta = [memory.type, ...memory.tags, recalls(memory, now), `saved ${age(memory.createdAt, now)} ago`];
  return shell(
    email,
    MEMORY_TAB,
    memory.name,
    `<p class="meta">${meta.map(escapeHtml).join(" · ")}</p>
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
    `<header class="bar"><h1>recall</h1></header>
<main><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p><p><a href="/dashboard">${escapeHtml(action)}</a></p></main>`,
  );
