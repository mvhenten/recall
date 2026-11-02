import { donut, heatmap, horizontalBars, miniBars, type Series, stackedArea, stackedBars } from "./charts";
import {
  DAY_MS,
  type DayWindow,
  type Focus,
  FRESH_WINDOW_DAYS,
  HISTORY_PARAMS,
  type HistoryFilters,
  type HistoryInput,
  IDLE_AFTER_MS,
  type Insights,
  LIST_PARAMS,
  type ListInput,
  type Live,
  type Memory,
  type MemoryCounts,
  type MemoryHit,
  type ModelBucket,
  type ModelTotals,
  memoryTypes,
  monthsBetween,
  type PastSession,
  type RepoHours,
  type Session,
  STALE_AFTER_DAYS,
  type Stats,
  type TokenCounts,
  USAGE_CHART_DAYS,
  USAGE_MONTH_DAYS,
  USAGE_WEEK_DAYS,
  type UsageSplit,
  type UsageSplitField,
  usageDay,
  usageMonth,
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

export const STATS_TAB: Tab = { path: "/dashboard/stats", label: "Stats", icon: BARS };
export const INSIGHTS_TAB: Tab = { path: "/dashboard/insights", label: "Insights", icon: SPARK };

export const TABS: Tab[] = [SESSIONS_TAB, HISTORY_TAB, MEMORY_TAB, STATS_TAB, INSIGHTS_TAB];

const FOCUS_FIRST_CHARS = 80;

export const tabForPath = (pathname: string): Tab | null =>
  TABS.find((tab) => tab.path === pathname.replace(/\/$/, "")) ?? null;

const TOKENS = `:root{color-scheme:light dark;
--bg:#f5f6f8;--surface:#fff;--surface2:#edeff4;
--ink:#171a20;--dim:#5a6373;--faint:#636c7c;
--line:#e2e5eb;--line2:#d2d7e0;
--accent:#3451b2;--on-accent:#fff;
--live:#157a42;--good:#157a42;--warn:#96670a;--bad:#b3362c;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;
--bar:#8595ac;--grid:#e7eaef;--axis:#c6ccd6;
--h0:#eef1f6;--h1:#dbe9fa;--h2:#9ec5f4;--h3:#5598e7;--h4:#256abf;--h5:#0d366b;
--t-user:#3451b2;--t-project:#157a62;--t-reference:#7a56c9;--t-feedback:#b4541f;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{
--bg:#111318;--surface:#1a1d24;--surface2:#232733;
--ink:#e7eaf0;--dim:#9aa3b2;--faint:#868f9e;
--line:#2a2f3a;--line2:#394050;
--accent:#93aaff;--on-accent:#121419;
--live:#56c988;--good:#56c988;--warn:#d9a441;--bad:#e4766c;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;
--bar:#5c6c85;--grid:#232833;--axis:#394050;
--h0:#20242e;--h1:#182c49;--h2:#1f4572;--h3:#2a62a4;--h4:#3987e5;--h5:#9ec5f4;
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
.kpis{display:grid;grid-template-columns:1fr 1fr;gap:.7rem}
.kpi{display:grid;gap:.4rem;padding:.9rem 1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;align-content:start}
.kpi .kl{font:600 .64rem/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}
.kpi .kv{font:600 1.65rem/1.1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.kpi .kv small{font-size:.95rem;font-weight:400;color:var(--dim)}
.kpi .kd{font:400 .72rem/1.3 var(--mono);color:var(--dim)}
.kpi .up{color:var(--good);font-weight:600}
.kpi .down{color:var(--bad);font-weight:600}
.charts{display:grid;gap:.7rem;align-items:start}
.cframe{display:grid;gap:.7rem;padding:1rem 1.1rem 1.1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;align-content:start}
.cframe .ch{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.cframe .ch b{font-size:.9rem}
.cframe .ch span{font:400 .7rem/1 var(--mono);color:var(--faint)}
.leg{display:flex;flex-wrap:wrap;gap:.9rem;margin:0;font-size:.74rem;color:var(--dim)}
.leg em{display:inline-flex;align-items:center;gap:.4rem;font-style:normal}
.leg i{flex:none;width:.6rem;height:.6rem;border-radius:3px}
.cfoot{margin:0;font:400 .7rem/1.4 var(--mono);color:var(--faint)}
svg text{font-family:var(--mono);font-variant-numeric:tabular-nums}
.cl-ax{font-size:10px;fill:var(--faint)}
.cl-val{font-size:11px;font-weight:600;fill:var(--dim)}
.cl-bl{font-size:11px;fill:var(--ink)}
.cl-hero{font-size:22px;font-weight:600;fill:var(--ink)}
.cl-sub{font-size:10px;fill:var(--faint)}
.mixtable{width:100%;border-collapse:collapse;font-size:.78rem}
.mixtable th{font:600 .62rem/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--faint);text-align:left;padding:.4rem 0;border-bottom:1px solid var(--line)}
.mixtable td{padding:.42rem 0;border-bottom:1px solid var(--line);color:var(--dim);overflow-wrap:anywhere}
.mixtable td:first-child{color:var(--ink);font-weight:600;font-size:.8rem}
.mixtable td.r,.mixtable th.r{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.mixtable tr:last-child td{border-bottom:0}
.mixtable td em{display:inline-block;width:.55rem;height:.55rem;border-radius:3px;margin-right:.45rem;font-style:normal;vertical-align:baseline}
.insight{display:grid;gap:.7rem;padding:1rem 1.1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;align-content:start}
.insight>.ih{display:grid;gap:.15rem}
.insight>.ih b{font-size:.9rem}
.insight>.ih span{font:400 .72rem/1.4 var(--mono);color:var(--faint)}
.ilist{list-style:none;margin:0;padding:0;display:grid}
.ilist li{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;padding:.42rem 0;border-bottom:1px solid var(--line)}
.ilist li:last-child{border-bottom:0}
.ilist .in{font:400 .8rem/1.3 var(--mono);overflow-wrap:anywhere}
.ilist .iv{font:400 .76rem/1 var(--mono);color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.ilist .iv.w{color:var(--warn);font-weight:600}
.callout{margin:0;font-size:.84rem;color:var(--dim)}
.callout strong{color:var(--ink);font-family:var(--mono)}
.heatleg{display:flex;align-items:center;gap:.3rem;margin:0;font:400 .68rem/1 var(--mono);color:var(--faint)}
.heatleg i{flex:none;width:.75rem;height:.75rem;border-radius:3px}
.wide{overflow-x:auto}
.noticewrap{max-width:34rem;margin:0 auto;padding:3rem 1.25rem;display:grid;gap:1.1rem}
.notice{display:grid;gap:.45rem;padding:1rem 1.1rem;background:var(--surface);border:1px solid var(--line2);border-left:3px solid var(--warn);border-radius:8px}
.notice h1,.notice b{margin:0;font-size:.92rem}
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
.kpis{grid-template-columns:repeat(5,1fr);gap:1rem}
.charts{gap:1rem}
.statrow{grid-template-columns:1fr 1fr 24rem}
.trio{grid-template-columns:repeat(3,1fr)}
.rhythm{grid-template-columns:2fr 1fr}
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

// Anthropic's published list prices in US dollars per million tokens. A cache write is the
// five-minute write rate, 1.25x input, and a cache read is 0.1x input. Tokens are stored and the
// money is worked out here on every read, so correcting a price needs no backfill.
interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const perMillion = (input: number, output: number): Price => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead: input * 0.1,
});

const FABLE = perMillion(10, 50);
const OPUS = perMillion(5, 25);
const SONNET = perMillion(3, 15);
const HAIKU = perMillion(1, 5);

const CLAUDE_FAMILIES: Array<[RegExp, Price]> = [
  [/^claude-(fable|mythos)\b/, FABLE],
  [/^claude-opus\b/, OPUS],
  [/^claude-sonnet\b/, SONNET],
  [/^claude-haiku\b/, HAIKU],
];

// The hooks send "claude"; a delta recorded by another client may name the vendor instead.
const PROVIDERS = new Map<string, Array<[RegExp, Price]>>([
  ["claude", CLAUDE_FAMILIES],
  ["anthropic", CLAUDE_FAMILIES],
]);

const MILLION = 1_000_000;

const priceOf = (provider: string, model: string): Price | null => {
  const families = PROVIDERS.get(provider.toLowerCase());
  if (!families) return null;
  return families.find(([family]) => family.test(model.toLowerCase()))?.[1] ?? null;
};

const costOf = (totals: ModelTotals): number | null => {
  const price = priceOf(totals.provider, totals.model);
  if (!price) return null;
  return (
    (totals.inputTokens * price.input +
      totals.outputTokens * price.output +
      totals.cacheWriteTokens * price.cacheWrite +
      totals.cacheReadTokens * price.cacheRead) /
    MILLION
  );
};

const spent = (totals: ModelTotals[]): number => totals.reduce((sum, entry) => sum + (costOf(entry) ?? 0), 0);

const money = (amount: number): string => `$${amount.toFixed(2)}`;

const dollars = (amount: number): string => `$${Math.round(amount).toLocaleString("en-US")}`;

const tokens = (count: number): string => {
  if (count < 1_000) return String(count);
  if (count < MILLION) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  const millions = count / MILLION;
  if (millions < 1) return `${millions.toFixed(2)}M`;
  if (millions < 10) return `${millions.toFixed(1)}M`;
  return `${Math.round(millions).toLocaleString("en-US")}M`;
};

const percent = (ratio: number, places: number): string => `${(ratio * 100).toFixed(places)}%`;

const summary = (live: Live): string => {
  const dot = live.busy === 0 ? "" : '<span class="livedot"></span>';
  const sessions = `${live.sessionsToday} ${live.sessionsToday === 1 ? "session" : "sessions"}`;
  return `<div class="ssum"><b>Now</b><p>${dot}<strong>${live.busy} busy</strong> · ${live.sessions} live</p>
<p><strong>${money(spent(live.today))}</strong> today · ${sessions}</p></div>`;
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

const dayHead = (group: DayGroup): string =>
  `<p class="dayhead"><b>${escapeHtml(group.day)} · ${WEEKDAYS[new Date(`${group.day}T00:00:00Z`).getUTCDay()] ?? ""}</b></p>`;

const historyRow = (session: PastSession): string =>
  `<li class="srow hrow"><p class="tm">${clock(session.startedAt)}–${clock(session.lastActivityAt)}</p>
<p class="h"><b>${escapeHtml(session.name)}</b> <span class="host">${escapeHtml(session.host)}</span>${session.running ? ' <span class="run">running</span>' : ""}</p>
<p class="fc">${focusHtml(session.focus)}</p>
<p class="smeta"><span class="rp">${escapeHtml(repoAtBranch(session.repo, session.branch))}</span><span class="ag">${span(session.lastActivityAt - session.startedAt)}</span><span class="pr">${session.prompts}<span class="unit"> ${session.prompts === 1 ? "prompt" : "prompts"}</span></span></p></li>`;

const dayBlock = (group: DayGroup): string =>
  `<section class="day">${dayHead(group)}<ol class="sessions" role="list">${group.sessions.map(historyRow).join("")}</ol></section>`;

const tabLink = (tab: Tab, keep: readonly string[], url: URL, changes: Record<string, string>): string => {
  const next = new URLSearchParams();
  for (const name of keep) {
    const value = url.searchParams.get(name) ?? "";
    if (value !== "") next.set(name, value);
  }
  for (const [name, value] of Object.entries(changes)) {
    if (value === "") next.delete(name);
    else next.set(name, value);
  }
  const query = next.toString();
  return escapeHtml(query === "" ? tab.path : `${tab.path}?${query}`);
};

const historyLink = (url: URL, changes: Record<string, string>): string =>
  tabLink(HISTORY_TAB, HISTORY_PARAMS, url, changes);

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
  known: HistoryFilters,
  sessions: PastSession[],
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
            : "A session lands here as soon as it syncs, and stays forever.",
        )
      : `<div class="hist">${groups.map(dayBlock).join("")}</div>${older}`;
  const filters = `<div class="toolrow">${historyChips(url, "host", "Filter by host", "All hosts", filter.host, offered(known.hosts, filter.host))}${historyChips(url, "repo", "Filter by repo", "All repos", filter.repo, offered(known.repos, filter.repo))}</div>`;
  return shell(email, HISTORY_TAB, live, HISTORY_TAB.label, "kept forever", `${filters}${listing}`);
};

const memoryLink = (url: URL, changes: Record<string, string>): string =>
  tabLink(MEMORY_TAB, ["q", ...LIST_PARAMS], url, changes);

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

const SERIES_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];

const keyOf = (totals: ModelTotals): string => `${totals.provider} ${totals.model}`;

const modelLabel = (model: string): string => {
  if (!model.startsWith("claude-")) return model;
  const [family, ...version] = model
    .slice("claude-".length)
    .replace(/-\d{8}$/, "")
    .split("-");
  if (!family) return model;
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
  return version.length === 0 ? name : `${name} ${version.join(".")}`;
};

const repoLabel = (repo: string): string => (repo === "" ? "global" : repo.replace(/^repo:github\.com\//, ""));

const NOTHING: TokenCounts = {
  prompts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

const totalled = (rows: TokenCounts[]): TokenCounts =>
  rows.reduce(
    (sum, row) => ({
      prompts: sum.prompts + row.prompts,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
    }),
    NOTHING,
  );

const countedTokens = (counts: TokenCounts): number =>
  counts.inputTokens + counts.outputTokens + counts.cacheWriteTokens + counts.cacheReadTokens;

const within = (rows: ModelBucket[], from: string, to: string): ModelBucket[] =>
  rows.filter((row) => row.bucket >= from && row.bucket <= to);

const inBucket = (rows: ModelBucket[], bucket: string): ModelBucket[] => rows.filter((row) => row.bucket === bucket);

const byModel = (rows: ModelTotals[]): ModelTotals[] => {
  const merged = new Map<string, ModelTotals[]>();
  for (const row of rows) merged.set(keyOf(row), [...(merged.get(keyOf(row)) ?? []), row]);
  return [...merged.values()]
    .flatMap((group) => {
      const first = group[0];
      return first ? [{ provider: first.provider, model: first.model, ...totalled(group) }] : [];
    })
    .sort((left, right) => (costOf(right) ?? -1) - (costOf(left) ?? -1));
};

interface Band {
  kind: "model" | "other";
  key: string;
  label: string;
  color: string;
}

const bandsOf = (models: ModelTotals[]): Band[] => {
  const top = models.slice(0, 3).map((model, index) => ({
    kind: "model" as const,
    key: keyOf(model),
    label: modelLabel(model.model),
    color: SERIES_COLORS[index] ?? "var(--s1)",
  }));
  if (models.length <= 3) return top;
  return [...top, { kind: "other" as const, key: "other", label: "Other", color: SERIES_COLORS[3] ?? "var(--s4)" }];
};

// Other holds every model no band of its own names. The test is written once, so the donut, the
// stacks and the table cannot disagree about which slice a model falls in.
const inBand = (band: Band, bands: Band[], totals: ModelTotals): boolean =>
  band.kind === "model"
    ? band.key === keyOf(totals)
    : !bands.some((other) => other.kind === "model" && other.key === keyOf(totals));

const bandCost = (band: Band, bands: Band[], models: ModelTotals[]): number =>
  models.filter((model) => inBand(band, bands, model)).reduce((sum, model) => sum + (costOf(model) ?? 0), 0);

const costSeries = (rows: ModelBucket[], buckets: string[], bands: Band[]): Series[] =>
  bands.map((band) => ({
    label: band.label,
    color: band.color,
    values: buckets.map((bucket) => bandCost(band, bands, inBucket(rows, bucket))),
  }));

const perBucket = (rows: ModelBucket[], buckets: string[], pick: (counts: TokenCounts) => number): number[] =>
  buckets.map((bucket) => inBucket(rows, bucket).reduce((sum, row) => sum + pick(row), 0));

const cacheHit = (counts: TokenCounts): number => {
  const fresh = counts.inputTokens + counts.cacheReadTokens;
  return fresh === 0 ? 0 : counts.cacheReadTokens / fresh;
};

interface Graded {
  bucket: string;
  counts: TokenCounts;
  hit: number;
}

// A bucket that read nothing out of its cache is a real zero and belongs in the grading; one with
// no fresh input at all has no ratio to grade, so it is left out rather than shown as 0%.
const gradedBuckets = (rows: ModelBucket[], buckets: string[]): Graded[] =>
  buckets
    .map((bucket) => ({ bucket, counts: totalled(inBucket(rows, bucket)) }))
    .filter((entry) => entry.counts.inputTokens + entry.counts.cacheReadTokens > 0)
    .map((entry) => ({ ...entry, hit: cacheHit(entry.counts) }));

// A null change means there is nothing earlier to divide by, which the strip says plainly rather
// than dressing a first week up as growth.
const trend = (change: number | null, against: string, size: (change: number) => string): string => {
  if (change === null) return "nothing earlier to compare";
  const rising = change >= 0;
  return `<span class="${rising ? "up" : "down"}">${rising ? "▲" : "▼"} ${escapeHtml(size(Math.abs(change)))}</span> ${escapeHtml(against)}`;
};

const relative = (current: number, baseline: number): number | null =>
  baseline === 0 ? null : (current - baseline) / baseline;

const asPercent = (change: number): string => `${(change * 100).toFixed(0)}%`;

const asPoints = (change: number): string => `${(change * 100).toFixed(1)}pt`;

const kpi = (label: string, value: string, note: string): string =>
  `<div class="kpi"><span class="kl">${escapeHtml(label)}</span><span class="kv">${value}</span><span class="kd">${note}</span></div>`;

const frame = (title: string, period: string, body: string): string =>
  `<div class="cframe"><div class="ch"><b>${escapeHtml(title)}</b><span>${escapeHtml(period)}</span></div>${body}</div>`;

const legend = (bands: Band[]): string =>
  `<p class="leg">${bands
    .map((band) => `<em><i style="background:${band.color}"></i>${escapeHtml(band.label)}</em>`)
    .join("")}</p>`;

const mixRows = (models: ModelTotals[], bands: Band[], total: number): string =>
  models
    .map((model) => {
      const cost = costOf(model);
      const swatch = bands.find((band) => inBand(band, bands, model))?.color ?? SERIES_COLORS[3];
      const share = cost === null || total === 0 ? "—" : percent(cost / total, 0);
      return `<tr><td><em style="background:${swatch}"></em>${escapeHtml(modelLabel(model.model))}</td><td class="r">${tokens(countedTokens(model))}</td><td class="r">${cost === null ? "unpriced" : dollars(cost)}</td><td class="r">${share}</td></tr>`;
    })
    .join("");

const pricedIn = (models: ModelTotals[]): number =>
  models.filter((model) => priceOf(model.provider, model.model) !== null).length;

// A row whose models are all unpriced must not read as free, and one that mixes priced and unpriced
// models is marked as the floor it is rather than a total.
const splitCost = (cost: number, priced: number, models: number): string => {
  if (priced === 0) return "unpriced";
  return priced === models ? money(cost) : `≈ ${money(cost)}`;
};

const totalCost = (models: ModelTotals[]): string => splitCost(spent(models), pricedIn(models), models.length);

const splitTable = (heading: string, field: UsageSplitField, splits: UsageSplit[]): string => {
  const grouped = new Map<string, UsageSplit[]>();
  for (const row of splits.filter((split) => split.field === field)) {
    grouped.set(row.value, [...(grouped.get(row.value) ?? []), row]);
  }
  const body = [...grouped.entries()]
    .map(([value, entries]) => ({
      value,
      counts: totalled(entries),
      cost: spent(entries),
      priced: pricedIn(entries),
      models: entries.length,
    }))
    .sort((left, right) => countedTokens(right.counts) - countedTokens(left.counts))
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.value === "" ? "global" : row.value)}</td><td class="r">${tokens(countedTokens(row.counts))}</td><td class="r">${escapeHtml(splitCost(row.cost, row.priced, row.models))}</td></tr>`,
    )
    .join("");
  return `<table class="mixtable"><tr><th>${escapeHtml(heading)}</th><th class="r">Tokens</th><th class="r">Cost</th></tr>${body}</table>`;
};

const unpricedNotice = (models: ModelTotals[]): string => {
  const missing = models.filter((model) => priceOf(model.provider, model.model) === null);
  if (missing.length === 0) return "";
  const counted = missing.reduce((sum, model) => sum + countedTokens(model), 0);
  const names = missing.map((model) => model.model).join(", ");
  return `<div class="notice"><b>${tokens(counted)} tokens carry no price.</b>
<p>${escapeHtml(names)} ${missing.length === 1 ? "has" : "have"} no entry in the price table, so ${missing.length === 1 ? "its" : "their"} tokens are counted and ${missing.length === 1 ? "its" : "their"} cost is left out rather than guessed.</p></div>`;
};

export const statsPage = (email: string, live: Live, stats: Stats, now: number): Response => {
  const { month, fortnight, week, prior } = stats.windows;
  const today = usageDay(now);
  const meta = `${month.from} → ${month.to}`;
  if (stats.usage.length === 0) {
    return shell(
      email,
      STATS_TAB,
      live,
      STATS_TAB.label,
      meta,
      emptyState(
        "No usage is recorded yet.",
        "A session reports the tokens it spent as it runs, and the first delta fills this page.",
      ),
    );
  }

  const monthModels = byModel(stats.usage);
  const bands = bandsOf(monthModels);
  const monthCost = spent(monthModels);

  const todayRows = inBucket(stats.usage, today);
  const todayCounts = totalled(todayRows);
  const todayCost = spent(byModel(todayRows));
  const weekRows = within(stats.usage, week.from, week.to);
  const weekCounts = totalled(weekRows);
  const weekCost = spent(byModel(weekRows));
  const weekHit = cacheHit(weekCounts);
  const priorRows = within(stats.usage, prior.from, prior.to);
  const priorCost = spent(byModel(priorRows));
  const priorHit = cacheHit(totalled(priorRows));

  const sessionsIn = (window: DayWindow): number =>
    stats.sessions
      .filter((day) => window.from <= day.day && day.day <= window.to)
      .reduce((sum, day) => sum + day.sessions, 0);
  const sessionsToday = stats.sessions.filter((day) => day.day === today).reduce((sum, day) => sum + day.sessions, 0);
  const sessionsWeek = sessionsIn(week);

  const kpis = `<div class="kpis">
${kpi("Cost today", money(todayCost), trend(relative(todayCost, weekCost / USAGE_WEEK_DAYS), "vs 7d avg", asPercent))}
${kpi(`Cost · ${USAGE_WEEK_DAYS} days`, money(weekCost), trend(relative(weekCost, priorCost), "vs prior 7d", asPercent))}
${kpi("Tokens today", `${tokens(todayCounts.inputTokens)} <small>in</small>`, escapeHtml(`${tokens(todayCounts.outputTokens)} out · ${tokens(todayCounts.cacheReadTokens)} cached`))}
${kpi("Cache hit · 7d", percent(weekHit, 0), trend(priorHit === 0 ? null : weekHit - priorHit, "vs prior 7d", asPoints))}
${kpi("Sessions today", String(sessionsToday), trend(relative(sessionsToday, sessionsWeek / USAGE_WEEK_DAYS), "vs 7d avg", asPercent))}
</div>`;

  const fortnightRows = within(stats.usage, fortnight.from, fortnight.to);
  const peak = fortnight.days
    .map((day) => ({ day, cost: spent(byModel(inBucket(stats.usage, day))) }))
    .reduce((best, entry) => (entry.cost > best.cost ? entry : best), { cost: 0, day: today });
  const costBars = frame(
    "Cost per day",
    `${USAGE_CHART_DAYS} days`,
    `${legend(bands)}${stackedBars(fortnight.days, "days", costSeries(fortnightRows, fortnight.days, bands), "Cost per day, stacked by model", money)}
<p class="cfoot">${escapeHtml(`list price · peak ${peak.day} ${money(peak.cost)}`)}</p>`,
  );
  const costArea = frame(
    `Cost · ${USAGE_MONTH_DAYS} days`,
    "stacked by model",
    stackedArea(month.days, costSeries(stats.usage, month.days, bands), "Cost over 30 days, stacked by model", money),
  );
  const mix = frame(
    "Model mix",
    `${USAGE_MONTH_DAYS} days · by cost`,
    `<div style="display:grid;justify-items:center">${donut(
      bands.map((band) => ({
        label: band.label,
        color: band.color,
        value: bandCost(band, bands, monthModels),
      })),
      dollars(monthCost),
      `${USAGE_MONTH_DAYS} days`,
      "Model mix by cost over 30 days",
    )}</div>
<table class="mixtable"><tr><th>Model</th><th class="r">Tokens</th><th class="r">Cost</th><th class="r">Share</th></tr>${mixRows(monthModels, bands, monthCost)}</table>`,
  );

  const inputs = perBucket(fortnightRows, fortnight.days, (counts) => counts.inputTokens);
  const outputs = perBucket(fortnightRows, fortnight.days, (counts) => counts.outputTokens);
  const reads = perBucket(fortnightRows, fortnight.days, (counts) => counts.cacheReadTokens);
  const small = `<div class="charts trio">
${frame("Tokens in", `${USAGE_CHART_DAYS} days`, `${miniBars(fortnight.days, inputs, "Input tokens per day", tokens(inputs.at(-1) ?? 0))}<p class="cfoot">fresh input, excluding cache reads</p>`)}
${frame("Tokens out", `${USAGE_CHART_DAYS} days`, `${miniBars(fortnight.days, outputs, "Output tokens per day", tokens(outputs.at(-1) ?? 0))}<p class="cfoot">completion tokens</p>`)}
${frame("Cache read", `${USAGE_CHART_DAYS} days`, `${miniBars(fortnight.days, reads, "Cache reads per day", tokens(reads.at(-1) ?? 0))}<p class="cfoot">priced at a tenth of fresh input</p>`)}
</div>`;

  const perPrompt = weekCounts.prompts === 0 ? null : weekCost / weekCounts.prompts;
  const perSession = sessionsWeek === 0 ? null : weekCost / sessionsWeek;
  const ratio = weekCounts.inputTokens === 0 ? null : weekCounts.outputTokens / weekCounts.inputTokens;
  const efficiency = frame(
    "Efficiency",
    `${USAGE_WEEK_DAYS} days`,
    `<ul class="ilist" role="list">
<li><span class="in">Cost per prompt</span><span class="iv">${perPrompt === null ? "—" : money(perPrompt)}</span></li>
<li><span class="in">Cost per session</span><span class="iv">${perSession === null ? "—" : money(perSession)}</span></li>
<li><span class="in">Tokens per prompt</span><span class="iv">${weekCounts.prompts === 0 ? "—" : tokens(Math.round((weekCounts.inputTokens + weekCounts.outputTokens) / weekCounts.prompts))}</span></li>
<li><span class="in">Output per input</span><span class="iv">${ratio === null ? "—" : `1 : ${(1 / ratio).toFixed(0)}`}</span></li>
<li><span class="in">Cache hit</span><span class="iv">${percent(weekHit, 1)}</span></li>
</ul>`,
  );

  const splits = `<div class="charts trio">
${efficiency}
${frame("By account", `${USAGE_MONTH_DAYS} days`, splitTable("Account", "account", stats.splits))}
${frame("By host", `${USAGE_MONTH_DAYS} days`, splitTable("Host", "host", stats.splits))}
</div>
${frame("By repo", `${USAGE_MONTH_DAYS} days`, splitTable("Repo", "repo", stats.splits))}`;

  return shell(
    email,
    STATS_TAB,
    live,
    STATS_TAB.label,
    meta,
    `${kpis}${unpricedNotice(monthModels)}<div class="charts statrow">${costBars}${costArea}${mix}</div>${small}${splits}`,
  );
};

const daysAgo = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / DAY_MS));

const roundHours = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const insightCard = (title: string, period: string, body: string): string =>
  `<div class="insight"><div class="ih"><b>${escapeHtml(title)}</b><span>${escapeHtml(period)}</span></div>${body}</div>`;

const insightList = (items: Array<{ name: string; value: string; warn: boolean }>): string =>
  `<ul class="ilist" role="list">${items
    .map(
      (item) =>
        `<li><span class="in">${escapeHtml(item.name)}</span><span class="iv${item.warn ? " w" : ""}">${escapeHtml(item.value)}</span></li>`,
    )
    .join("")}</ul>`;

const repoBars = (repos: RepoHours[], label: string): string =>
  horizontalBars(
    repos.map((repo) => ({
      label: repoLabel(repo.repo),
      title: repo.repo === "" ? "global" : repo.repo,
      value: repo.ms,
      text: roundHours(repo.ms),
    })),
    label,
  );

interface LongHorizon {
  months: string[];
  monthly: ModelBucket[];
}

// Every number beside the axis reads the rows of the months on it, so a delta dated ahead of today
// cannot lift a headline above the bars.
const longHorizon = (monthly: ModelBucket[], now: number): LongHorizon => {
  const months = monthsBetween(monthly[0]?.bucket ?? "", usageMonth(now));
  return { months, monthly: within(monthly, months[0] ?? "", months.at(-1) ?? "") };
};

const monthlyCost = (horizon: LongHorizon): string => {
  const { months, monthly } = horizon;
  if (monthly.length === 0) {
    return emptyState(
      "No month of usage is on record yet.",
      "A month appears here as soon as a session reports the tokens it spent.",
    );
  }
  const models = byModel(monthly);
  if (pricedIn(models) === 0) {
    const names = models.map((model) => model.model).join(", ");
    return emptyState(
      "No model on record carries a price.",
      `${names} ${models.length === 1 ? "has" : "have"} no entry in the price table, so these months are counted and never priced.`,
    );
  }
  const bands = bandsOf(models);
  const peak = months
    .map((month) => ({ month, models: byModel(inBucket(monthly, month)) }))
    .reduce((best, entry) => (spent(entry.models) > spent(best.models) ? entry : best));
  return `${legend(bands)}${stackedBars(months, "months", costSeries(monthly, months, bands), "Cost by month, stacked by model", money)}
<p class="callout"><strong>${escapeHtml(totalCost(models))}</strong> and ${escapeHtml(tokens(countedTokens(totalled(monthly))))} tokens over ${months.length} ${months.length === 1 ? "month" : "months"}, peaking in <strong>${escapeHtml(peak.month)}</strong> at ${escapeHtml(totalCost(peak.models))}.</p>`;
};

const cacheDrift = (horizon: LongHorizon): string => {
  const graded = gradedBuckets(horizon.monthly, horizon.months);
  const first = graded[0];
  const last = graded.at(-1);
  if (first === undefined || last === undefined) {
    return emptyState(
      "No month has any input to grade.",
      "A month earns a hit rate once a session reports fresh input or a cache read.",
    );
  }
  const drift =
    first.bucket === last.bucket
      ? `<strong>${escapeHtml(first.bucket)}</strong> is the only month with input to grade, at ${percent(first.hit, 1)}.`
      : `The hit rate went from <strong>${percent(first.hit, 1)}</strong> in ${escapeHtml(first.bucket)} to <strong>${percent(last.hit, 1)}</strong> in ${escapeHtml(last.bucket)}.`;
  return `${horizontalBars(
    graded.map((entry) => ({
      label: entry.bucket,
      title: `${entry.bucket} · ${tokens(entry.counts.cacheReadTokens)} cached of ${tokens(entry.counts.inputTokens + entry.counts.cacheReadTokens)}`,
      value: entry.hit,
      text: percent(entry.hit, 1),
    })),
    "Cache hit rate by month",
    1,
  )}<p class="callout">${drift}</p>`;
};

const busiestRepos = (repos: RepoHours[]): string => {
  const leader = repos[0];
  if (leader === undefined) {
    return emptyState("No session has ever synced.", "Every session that syncs lands here, and stays.");
  }
  const ms = repos.reduce((sum, repo) => sum + repo.ms, 0);
  const sessions = repos.reduce((sum, repo) => sum + repo.sessions, 0);
  const held = repos.length === 1 ? "the one repo on record holds" : `these ${repos.length} repos hold`;
  return `${repoBars(repos, "Session time by repo, all time")}
<p class="callout"><strong>${escapeHtml(repoLabel(leader.repo))}</strong> took ${escapeHtml(roundHours(leader.ms))} of the ${escapeHtml(roundHours(ms))} ${held}, over ${sessions} ${sessions === 1 ? "session" : "sessions"}.</p>`;
};

export const insightsPage = (email: string, live: Live, insights: Insights, now: number): Response => {
  const { fortnight } = insights;
  const counts = totalled(insights.usage);

  const working =
    insights.working.entries.length === 0
      ? emptyState("No memory has been recalled lately.", "A memory lands here once a session recalls it.")
      : `${insightList(
          insights.working.entries.map((entry, index) => ({
            name: entry.name,
            value: index === 0 ? `${entry.recalls} recalls` : String(entry.recalls),
            warn: false,
          })),
        )}
<p class="callout">${
          insights.working.entries.length === 1
            ? "One memory carries"
            : `These ${insights.working.entries.length} carry`
        } <strong>${percent(
          insights.working.recalls === 0
            ? 0
            : insights.working.entries.reduce((sum, entry) => sum + entry.recalls, 0) / insights.working.recalls,
          0,
        )}</strong> of every recall in the window. They are the ones worth keeping sharp.</p>`;

  const stale =
    insights.stale.entries.length === 0
      ? emptyState("Nothing is going stale.", "Every memory has been recalled recently enough to earn its place.")
      : `${insightList(
          insights.stale.entries.map((entry) => ({
            name: entry.name,
            value: entry.recalled
              ? `${daysAgo(entry.lastRecalledAt, now)}d ago`
              : `never · saved ${daysAgo(entry.createdAt, now)}d`,
            warn: true,
          })),
        )}
<p class="callout"><strong>${insights.stale.atRisk} of ${insights.stale.total}</strong> memories are at risk. Prune them or fold them into the ones that do get recalled — a smaller store ranks better.</p>`;

  const savings = insights.usage.reduce((sum, row) => {
    const price = priceOf(row.provider, row.model);
    return price === null ? sum : sum + (row.cacheReadTokens * (price.input - price.cacheRead)) / MILLION;
  }, 0);
  // One graded day is both the best and the worst, which says nothing, so the pair appears only
  // once there are two days to tell apart.
  const ranked = gradedBuckets(insights.usage, fortnight.days).sort((left, right) => left.hit - right.hit);
  const worst = ranked[0];
  const best = ranked.at(-1);
  const extremes =
    best === undefined || worst === undefined || best.bucket === worst.bucket
      ? []
      : [
          { name: "Best day", value: `${best.bucket} · ${percent(best.hit, 1)}`, warn: false },
          { name: "Worst day", value: `${worst.bucket} · ${percent(worst.hit, 1)}`, warn: true },
        ];
  const cache =
    counts.cacheReadTokens === 0
      ? emptyState("No cache read is recorded yet.", "Cache economics appear once a session reuses a prompt prefix.")
      : `${insightList([
          { name: "Cache reads", value: `${tokens(counts.cacheReadTokens)} tokens`, warn: false },
          { name: "Saved vs fresh input", value: `≈ ${money(savings)}`, warn: false },
          ...extremes,
        ])}
<p class="callout"><strong>${percent(cacheHit(counts), 0)}</strong> of the fortnight's input came back out of the cache, at a tenth of the price of a fresh read.</p>`;

  const busiest = insights.rhythm.reduce((top, cell) => (cell.sessions > top.sessions ? cell : top), {
    weekday: 0,
    hour: 0,
    sessions: 0,
  });
  const rhythm =
    insights.rhythm.length === 0
      ? emptyState("No session has been recorded yet.", "The week fills in as sessions sync from your hosts.")
      : `${heatmap(insights.rhythm, "Sessions by hour of day and weekday")}
<p class="heatleg">fewer <i style="background:var(--h0)"></i><i style="background:var(--h1)"></i><i style="background:var(--h2)"></i><i style="background:var(--h3)"></i><i style="background:var(--h4)"></i><i style="background:var(--h5)"></i> more</p>
<p class="callout">The busiest hour is <strong>${escapeHtml(`${String(busiest.hour).padStart(2, "0")}:00`)}</strong> on ${escapeHtml(WEEKDAY_NAMES[busiest.weekday] ?? "")}, with ${busiest.sessions} ${busiest.sessions === 1 ? "session" : "sessions"} started.</p>`;

  const totalMs = insights.repos.reduce((sum, repo) => sum + repo.ms, 0);
  const leader = insights.repos[0];
  const hours =
    insights.repos.length === 0
      ? emptyState("No session ran in this window.", "A session's span lands here as soon as it syncs.")
      : `${repoBars(insights.repos, "Session time by repo")}
<p class="callout"><strong>${escapeHtml(repoLabel(leader?.repo ?? ""))}</strong> took ${escapeHtml(roundHours(leader?.ms ?? 0))} of the fortnight's ${escapeHtml(roundHours(totalMs))} of session time.</p>`;

  const horizon = longHorizon(insights.monthly, now);

  return shell(
    email,
    INSIGHTS_TAB,
    live,
    INSIGHTS_TAB.label,
    `last ${USAGE_CHART_DAYS} days · all time`,
    `<div class="charts trio">
${insightCard("The working set", `most recalled · recalled in the last ${USAGE_MONTH_DAYS} days`, working)}
${insightCard("Going stale", `not recalled in ${STALE_AFTER_DAYS}+ days, or never`, stale)}
${insightCard("Cache economics", `${USAGE_CHART_DAYS} days`, cache)}
</div>
<div class="charts rhythm">
${insightCard("The rhythm", `sessions by hour and weekday · ${USAGE_CHART_DAYS} days`, `<div class="wide">${rhythm}</div>`)}
${insightCard("Where the hours went", `session time by repo · ${USAGE_CHART_DAYS} days`, hours)}
</div>
<div class="charts trio">
${insightCard("Month by month", "cost by model · every month on record", monthlyCost(horizon))}
${insightCard("Busiest repos", "session time · every session on record", busiestRepos(insights.allTime))}
${insightCard("Cache drift", "hit rate by month · every month on record", cacheDrift(horizon))}
</div>`,
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
