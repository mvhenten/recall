import { escapeHtml, htmlPage } from "./page";

export interface Tab {
  path: string;
  label: string;
}

export const TABS: Tab[] = [
  { path: "/dashboard", label: "Sessions" },
  { path: "/dashboard/memory", label: "Memory" },
  { path: "/dashboard/stats", label: "Stats" },
  { path: "/dashboard/insights", label: "Insights" },
];

const PLACEHOLDER = "Nothing to show here yet.";

export const tabForPath = (pathname: string): Tab | null =>
  TABS.find((tab) => tab.path === pathname.replace(/\/$/, "")) ?? null;

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--ink:#1a1a1a;--dim:#5c5c66;--line:#e3e3e8;--accent:#2b53c8}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--ink:#ededf2;--dim:#9b9ba6;--line:#2b2b33;--accent:#92b2ff}}
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
@media (min-width:48rem){
body{padding-bottom:0}
.tabs{position:static;max-width:60rem;margin:0 auto;grid-template-columns:repeat(4,max-content);border-top:0;border-bottom:1px solid var(--line)}
.tabs a{padding:.7rem 1.1rem;font-size:.95rem}
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
<main><h2>${escapeHtml(tab.label)}</h2><p class="empty">${PLACEHOLDER}</p></main>`,
  );

export const dashboardNotice = (status: number, title: string, text: string, action: string): Response =>
  htmlPage(
    status,
    `recall ${title.toLowerCase()}`,
    STYLE,
    `<header class="bar"><h1>recall</h1></header>
<main><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p><p><a href="/dashboard">${escapeHtml(action)}</a></p></main>`,
  );
