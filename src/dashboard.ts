import { escapeHtml, htmlPage } from "./page";

export interface Tab {
  path: string;
  label: string;
  heading: string;
  empty: string;
}

export const TABS: Tab[] = [
  {
    path: "/dashboard",
    label: "Sessions",
    heading: "Live sessions",
    empty: "No host has a session open right now.",
  },
  {
    path: "/dashboard/memory",
    label: "Memory",
    heading: "Memory",
    empty: "Nothing to browse here yet.",
  },
  {
    path: "/dashboard/stats",
    label: "Stats",
    heading: "Stats",
    empty: "No usage has been recorded yet.",
  },
  {
    path: "/dashboard/insights",
    label: "Insights",
    heading: "Insights",
    empty: "Nothing stands out yet.",
  },
];

export const tabForPath = (pathname: string): Tab | null =>
  TABS.find((tab) => tab.path === pathname.replace(/\/$/, "")) ?? null;

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--card:#f5f5f7;--ink:#1a1a1a;--dim:#5c5c66;--line:#e3e3e8;--accent:#2b53c8}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1c1c21;--ink:#ededf2;--dim:#9b9ba6;--line:#2b2b33;--accent:#92b2ff}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--ink);background:var(--bg);padding-bottom:4.5rem}
.bar{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;padding:.9rem 1rem;border-bottom:1px solid var(--line)}
.bar h1{margin:0;font-size:1.05rem;letter-spacing:.04em;text-transform:lowercase}
.who{margin:0;font-size:.8rem;color:var(--dim);overflow-wrap:anywhere}
.tabs{position:fixed;inset:auto 0 0 0;display:grid;grid-template-columns:repeat(4,1fr);background:var(--bg);border-top:1px solid var(--line)}
.tabs a{padding:.85rem .25rem;text-align:center;font-size:.8rem;color:var(--dim);text-decoration:none}
.tabs a[aria-current]{color:var(--accent);box-shadow:inset 0 2px 0 var(--accent)}
main{max-width:60rem;margin:0 auto;padding:1rem}
main h2{margin:0 0 .9rem;font-size:1.35rem}
.feed{display:grid;gap:.6rem;margin:0;padding:0;list-style:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:.7rem;padding:1rem}
.card p{margin:0}
.empty{color:var(--dim);text-align:center}
@media (min-width:48rem){
body{padding-bottom:0}
.tabs{position:static;max-width:60rem;margin:0 auto;grid-template-columns:repeat(4,max-content);border-top:0;border-bottom:1px solid var(--line)}
.tabs a{padding:.7rem 1.1rem;font-size:.95rem}
.feed{gap:0}
.card{background:none;border-width:0 0 1px;border-radius:0;padding:.55rem .25rem}
.empty{text-align:left;padding:.9rem .25rem}
}`;

const navigation = (current: Tab): string =>
  `<nav class="tabs" aria-label="Dashboard">${TABS.map(
    (tab) => `<a href="${tab.path}"${tab === current ? ' aria-current="page"' : ""}>${escapeHtml(tab.label)}</a>`,
  ).join("")}</nav>`;

export const dashboardPage = (email: string, tab: Tab): Response =>
  htmlPage(
    200,
    `recall ${tab.label.toLowerCase()}`,
    STYLE,
    `<header class="bar"><h1>recall</h1><p class="who">${escapeHtml(email)}</p></header>
${navigation(tab)}
<main><h2>${escapeHtml(tab.heading)}</h2><ul class="feed"><li class="card empty"><p>${escapeHtml(tab.empty)}</p></li></ul></main>`,
  );
