import { type ArtifactType, type ArtifactView, artifactTypes } from "./artifacts";
import { addressText, BOARD_DAYS, type BoardEntry, posterOf } from "./board";
import { donut, heatmap, horizontalBars, miniBars, type Series, stackedArea, stackedBars } from "./charts";
import {
  ARTIFACT_SORTS,
  CURSOR_PARAM,
  emptyState,
  HISTORY_SORTS,
  type Listing,
  type ListingChip,
  type ListingFilter,
  listingMain,
  MEMORY_SORTS,
  SORT_PARAM,
  sortInForce,
} from "./listing";
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
  type LabelKind,
  type Labels,
  type LabelTargets,
  LIST_PARAMS,
  type ListInput,
  type Live,
  MAX_SESSION_TEXT_CHARS,
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
  type SessionSpend,
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
import { CSRF_COOKIE, escapeHtml, htmlPage, SCRIPT_CSP, SENT_COOKIE, sizeText, TOKENS } from "./page";
import { MAX_EMAIL_SHARES, SHARE_DAYS, type ShareView, shareTimeLeft } from "./shares";
import { type Follow, gapsIn, listedRuns, type Plan, type Run, type Listing as RunListing } from "./transcript-plan";
import { TRANSCRIPT_SCRIPT } from "./transcript-view.generated";
import { MAIN_FILE } from "./transcripts";

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
const TAG = '<path d="M3.3 10.6 10.6 3.3h6.1v6.1L9.4 16.7z"/><circle cx="13.4" cy="6.6" r="1.2"/>';
const SHEET = '<path d="M5.5 3.5h5.9l3.1 3.1v9.9h-9z"/><path d="M11.2 3.5v3.4h3.3"/>';
const NOTE = '<path d="M3.5 4.5h13v8H9.5l-3.4 3v-3H3.5z"/>';

export const SESSIONS_TAB: Tab = { path: "/dashboard", label: "Sessions", icon: DISC };
export const BOARD_TAB: Tab = { path: "/dashboard/board", label: "Board", icon: NOTE };
export const HISTORY_TAB: Tab = { path: "/dashboard/history", label: "History", icon: CLOCK };
export const MEMORY_TAB: Tab = { path: "/dashboard/memory", label: "Memory", icon: BOOKMARK };
export const ARTIFACTS_TAB: Tab = { path: "/dashboard/artifacts", label: "Artifacts", icon: SHEET };

export const STATS_TAB: Tab = { path: "/dashboard/stats", label: "Stats", icon: BARS };
export const INSIGHTS_TAB: Tab = { path: "/dashboard/insights", label: "Insights", icon: SPARK };
export const LABELS_TAB: Tab = { path: "/dashboard/labels", label: "Labels", icon: TAG };

export const TABS: Tab[] = [
  SESSIONS_TAB,
  BOARD_TAB,
  HISTORY_TAB,
  MEMORY_TAB,
  ARTIFACTS_TAB,
  STATS_TAB,
  INSIGHTS_TAB,
  LABELS_TAB,
];

const FOCUS_FIRST_CHARS = 80;

export const tabForPath = (pathname: string): Tab | null =>
  TABS.find((tab) => tab.path === pathname.replace(/\/$/, "")) ?? null;

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
.snav{position:fixed;inset:auto 0 0 0;z-index:1;display:grid;grid-template-columns:repeat(8,1fr);border-top:1px solid var(--line);background:var(--surface)}
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
.toolrow{display:flex;gap:.9rem;align-items:center;flex-wrap:wrap;min-width:0}
.find{display:flex;gap:.5rem;flex:1;min-width:0;max-width:30rem;margin:0}
.find input{flex:1 1 7rem;font:inherit;font-size:.9rem;padding:.5rem .75rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink);min-width:0}
.find input::placeholder{color:var(--faint)}
.find button{font:600 .85rem/1 var(--sans);padding:.5rem .9rem;border:0;border-radius:6px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.chips{display:flex;gap:.4rem;flex-wrap:nowrap;overflow-x:auto;padding-bottom:.2rem}
.chips a{font:400 .74rem/1 var(--mono);color:var(--dim);text-decoration:none;white-space:nowrap;padding:.35rem .55rem;border:1px solid var(--line2);border-radius:999px;background:var(--surface)}
.chips a[aria-current]{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.sorts{display:flex;gap:.3rem;flex-wrap:wrap}
.sorts a,.sorts span{font:400 .74rem/1 var(--mono);color:var(--dim);text-decoration:none;white-space:nowrap;padding:.35rem .55rem;border:1px solid var(--line2);border-radius:4px;background:var(--surface)}
.sorts a[aria-current]{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.sorts a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.sorts.inert span{border-style:dashed;color:var(--faint);background:none}
.sortwhy{margin:0;font:400 .74rem/1.4 var(--mono);color:var(--faint)}
.atitle{font:400 .8rem/1.35 var(--sans);color:var(--dim);overflow-wrap:anywhere}
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
.labels{display:grid;gap:.7rem}
.lrows{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
.lrows li{display:grid;gap:.25rem}
.lrows .lv{font:400 .74rem/1.4 var(--mono);color:var(--faint);overflow-wrap:anywhere}
.lrows input{width:100%;min-width:0;font:inherit;font-size:.9rem;padding:.5rem .75rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink)}
.lrows input::placeholder{color:var(--faint)}
.lrows input:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.lsave{margin:0}
.lsave button{font:600 .85rem/1 var(--sans);padding:.55rem 1.1rem;border:0;border-radius:6px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.turns{list-style:none;margin:0;padding:0;display:grid;gap:.9rem}
.turn{display:grid;gap:.25rem}
.who{margin:0;font:600 .62rem/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}
.turn.user .who{color:var(--accent)}
.say{margin:0;padding:.7rem .85rem;border-radius:6px;background:var(--surface2);font:400 .82rem/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.turn.model .say{padding:.1rem 0;background:none}
.scroller{max-height:34rem;overflow-y:auto;overscroll-behavior:contain;padding:.85rem .9rem;border:1px solid var(--line2);border-radius:8px;background:var(--surface)}
.scroller:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.txtop{margin:0 0 .9rem;text-align:center}
.txtop button{font:600 .78rem/1 var(--sans);padding:.4rem .9rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface2);color:var(--ink);cursor:pointer}
.txtop button[disabled]{opacity:.5;cursor:default}
.txnote{margin:.55rem 0 0;font-size:.8rem;color:var(--faint)}
.txnote:empty{display:none}
.txnote.bad{color:var(--bad)}
.txnote a{margin-left:.3rem}
.send{display:grid;gap:.6rem;margin:0}
.send textarea{width:100%;min-height:6.5rem;resize:vertical;font:inherit;font-size:.9rem;padding:.6rem .75rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink)}
.send textarea::placeholder{color:var(--faint)}
.send textarea:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.send button{justify-self:start;font:600 .85rem/1 var(--sans);padding:.55rem 1.1rem;border:0;border-radius:6px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.flash{margin:0;padding:.6rem .8rem;border:1px solid var(--line2);border-left:3px solid var(--good);border-radius:6px;background:var(--surface2);font-size:.85rem}
.flash.bad{border-left-color:var(--bad);border-left-style:dashed}
.send select{font:inherit;font-size:.9rem;padding:.5rem .6rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink)}
.bbody{margin:0;font:400 .88rem/1.5 var(--sans);white-space:pre-wrap;overflow-wrap:anywhere}
.bwait{color:var(--good)}
.btook{color:var(--faint)}
.sopen{margin:0}
.sopen a{font:600 .8rem/1 var(--sans);text-decoration:none}
.sopen a::after{content:" \\2197"}
.minted{display:grid;gap:.5rem;margin:0;padding:.9rem 1rem;background:var(--surface);border:1px solid var(--line2);border-left:3px solid var(--good);border-radius:8px}
.minted b{font-size:.92rem}
.minted p{margin:0;font-size:.85rem;color:var(--dim)}
.maddr{padding:.65rem .75rem;background:var(--surface2);border-radius:6px;font:400 .82rem/1.65 var(--mono);color:var(--ink);overflow-wrap:anywhere;user-select:all}
.scre{display:grid;gap:.5rem;margin:0}
.scre h2{margin:0;font-size:.92rem}
.scre input{width:100%;min-width:0;font:inherit;font-size:.9rem;padding:.5rem .75rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--ink)}
.scre input::placeholder{color:var(--faint)}
.scre input:focus-visible,.sgo:focus-visible,.sctl:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sgo{justify-self:start;font:600 .85rem/1 var(--sans);padding:.55rem 1.1rem;border:0;border-radius:6px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.sgo[aria-disabled=true]{background:none;color:var(--faint);border:1px dashed var(--line2);cursor:default}
.sctl{display:inline-block;font:600 .85rem/1 var(--sans);padding:.55rem 1.1rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--accent);text-decoration:none;cursor:pointer}
.sctl[aria-disabled=true]{border-style:dashed;color:var(--faint);cursor:default}
.slinks{display:flex;flex-wrap:wrap;gap:.5rem;margin:0}
.ask{border-left-color:var(--bad)}
.ask p{margin:0;font-size:.85rem;color:var(--dim)}
.sacts{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.sacts form{margin:0}
.shrow .smode{font:400 .72rem/1.4 var(--mono);color:var(--faint)}
.shrow .sleft{display:block;font:400 .72rem/1.4 var(--mono);color:var(--warn)}
.shrow .srev{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.2rem}
.shrow .srev .sctl{flex:1;text-align:center}
.smark{font:600 .64rem/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--dim)}
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
.ag,.pr,.ab,.at{font:400 .8rem/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--dim);text-align:right}
.lhead .r{text-align:right}
.unit{display:none}
.hist{grid-template-columns:1fr 1fr;gap:1.2rem 1rem}
.hrow{grid-template-columns:8.5rem 9rem 14rem minmax(0,1fr) 4.5rem 5.5rem}
.hrow .tm{grid-area:1/1}
.arow{grid-template-columns:minmax(0,1fr) 7rem 5rem 8.5rem 7.5rem 9rem;align-items:start}
.arow .h{grid-area:1/1/3/2;display:grid;gap:.1rem;align-content:start}
.arow .h b{font-size:.84rem}
.arow .aty{grid-area:1/2}
.arow .afc{grid-area:2/2}
.arow .ab{grid-area:1/3/3/4}
.arow .at{grid-area:1/4/3/5}
.arow .ard{grid-area:1/5}
.arow .awr{grid-area:2/5}
.arow .alw{grid-area:1/6;text-align:left}
.arow .ash{grid-area:2/6;font:400 .78rem/1.35 var(--mono);text-align:left}
.arow .aty,.arow .afc,.arow .ard,.arow .awr,.arow .alw{font:400 .78rem/1.35 var(--mono);color:var(--dim);overflow-wrap:anywhere}
.arow .afc,.arow .awr{color:var(--faint)}
.arow.lhead{align-items:center}
.shrow{grid-template-columns:minmax(0,1fr) 7rem 8rem 7rem 4.5rem 7rem;align-items:start}
.shrow .h{grid-area:1/1;display:grid;gap:.1rem;align-content:start}
.shrow .h b{font-size:.84rem}
.shrow .scr{grid-area:1/2}
.shrow .sex{grid-area:1/3}
.shrow .slo{grid-area:1/4}
.shrow .sus{grid-area:1/5;text-align:right}
.shrow .scr,.shrow .sex,.shrow .slo,.shrow .sus{font:400 .78rem/1.35 var(--mono);color:var(--dim);font-variant-numeric:tabular-nums}
.shrow .srev{grid-area:1/6;margin-top:0;justify-content:flex-end}
.shrow .srev .sctl{flex:none;font-size:.78rem;padding:.35rem .7rem}
.memories{grid-template-columns:repeat(auto-fill,minmax(18rem,1fr));gap:1rem}
.chips{flex-wrap:wrap;overflow-x:visible}
.kpis{grid-template-columns:repeat(5,1fr);gap:1rem}
.charts{gap:1rem}
.statrow{grid-template-columns:1fr 1fr 24rem}
.trio{grid-template-columns:repeat(3,1fr)}
.duo{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.rhythm{grid-template-columns:2fr 1fr}
.lrows li{grid-template-columns:16rem minmax(0,1fr);align-items:center;gap:.9rem}
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

const isBusy = (session: { lastActivityAt: number }, now: number): boolean =>
  now - session.lastActivityAt < IDLE_AFTER_MS;

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

const shell = (
  email: string,
  tab: Tab,
  live: Live,
  heading: string,
  meta: string,
  main: string,
  headers: Record<string, string | string[]> = {},
  status = 200,
): Response =>
  htmlPage(
    status,
    `recall ${heading.toLowerCase()}`,
    STYLE,
    `<div class="app"><header class="side"><p class="brand"><i></i>recall</p>
${navigation(tab)}
${summary(live)}
<p class="swho">${escapeHtml(email)}</p></header>
<main><div class="pagehead"><h1>${escapeHtml(heading)}</h1><span>${escapeHtml(meta)}</span></div>${main}</main></div>`,
    headers,
  );

// The name a page prints for a raw host or account. Filtering and grouping stay on the raw value;
// only what the reader sees changes.
const labelled = (labels: Map<string, string>, value: string): string => labels.get(value) ?? value;

export const SESSIONS_PATH = "/dashboard/sessions";

export const sessionPath = (sessionId: string): string => `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}`;

const sessionLink = (sessionId: string, changes: Record<string, string>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(changes)) {
    if (value !== "") params.set(name, value);
  }
  const query = params.toString();
  return escapeHtml(query === "" ? sessionPath(sessionId) : `${sessionPath(sessionId)}?${query}`);
};

const handleLink = (sessionId: string, name: string): string =>
  `<b><a href="${escapeHtml(sessionPath(sessionId))}">${escapeHtml(name)}</a></b>`;

const sessionRow = (session: Session, labels: Labels, now: number): string => {
  const busy = isBusy(session, now);
  const state = busy ? "busy" : `idle ${age(session.lastActivityAt, now)}`;
  const focus = focusHtml(session.focus);
  return `<li class="srow${busy ? "" : " idle"}"><p class="h">${handleLink(session.sessionId, session.name)} <span class="host">${escapeHtml(labelled(labels.hosts, session.host))}</span></p>
<p class="${busy ? "state busy" : "state"}"><span class="dot"></span>${state}</p>
<p class="fc">${focus}</p>
<p class="smeta"><span class="rp">${escapeHtml(repoAtBranch(session.repo, session.branch))}</span><span class="ag">${age(session.startedAt, now)}</span><span class="pr">${session.prompts}<span class="unit"> ${session.prompts === 1 ? "prompt" : "prompts"}</span></span></p></li>`;
};

const LEDGER_HEAD =
  '<li class="srow lhead" aria-hidden="true"><span>State</span><span>Session</span><span>Repo</span><span>Focus</span><span class="r">Age</span><span class="r">Prompts</span></li>';

// listSessions answers newest activity first, which already floats every busy session above the
// idle ones.
const ledger = (sessions: Session[], labels: Labels, now: number): string =>
  `<ol class="sessions" role="list">${LEDGER_HEAD}${sessions.map((session) => sessionRow(session, labels, now)).join("")}</ol>`;

const hostsCard = (sessions: Session[], labels: Labels, now: number): string => {
  const hosts = new Map<string, { live: number; busy: number }>();
  for (const session of sessions) {
    const tally = hosts.get(session.host) ?? { live: 0, busy: 0 };
    hosts.set(session.host, { live: tally.live + 1, busy: tally.busy + (isBusy(session, now) ? 1 : 0) });
  }
  const lines = [...hosts]
    .map(
      ([host, tally]) =>
        `<p><strong><a href="${escapeHtml(`${HISTORY_TAB.path}?host=${encodeURIComponent(host)}`)}">${escapeHtml(labelled(labels.hosts, host))}</a></strong> · ${tally.live} ${tally.live === 1 ? "session" : "sessions"} · ${tally.busy} busy</p>`,
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

// Sessions supplies its rows and nothing else: no paging, no search and no sort, so it draws no
// toolrow and no page end. Its ledger and its rail cards are one block at the wide breakpoint, so
// they ride in as the rows they are.
export const sessionsPage = (
  email: string,
  live: Live,
  url: URL,
  sessions: Session[],
  labels: Labels,
  now: number,
): Response => {
  const listing: Listing = {
    tab: SESSIONS_TAB,
    noun: { one: "session", many: "sessions" },
    params: [],
    search: null,
    filters: [],
    sorts: [],
    sort: "",
    unknownSort: "",
    rows:
      sessions.length === 0
        ? ""
        : `<div class="withrail">${ledger(sessions, labels, now)}<div class="rail">${hostsCard(sessions, labels, now)}${oldestIdleCard(sessions, now)}</div></div>`,
    empty: {
      headline: "No session is running on any of your hosts.",
      hint: "A session appears here within a minute of its first prompt.",
    },
    nextCursor: "",
    cut: false,
  };
  return shell(
    email,
    SESSIONS_TAB,
    live,
    SESSIONS_TAB.label,
    `${live.sessions} live · ${live.busy} busy`,
    listingMain(url, listing),
  );
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

const historyRow = (session: PastSession, labels: Labels): string =>
  `<li class="srow hrow"><p class="tm">${clock(session.startedAt)}–${clock(session.lastActivityAt)}</p>
<p class="h">${handleLink(session.sessionId, session.name)} <span class="host">${escapeHtml(labelled(labels.hosts, session.host))}</span>${session.running ? ' <span class="run">running</span>' : ""}</p>
<p class="fc">${focusHtml(session.focus)}</p>
<p class="smeta"><span class="rp">${escapeHtml(repoAtBranch(session.repo, session.branch))}</span><span class="ag">${span(session.lastActivityAt - session.startedAt)}</span><span class="pr">${session.prompts}<span class="unit"> ${session.prompts === 1 ? "prompt" : "prompts"}</span></span></p></li>`;

const dayBlock = (group: DayGroup, labels: Labels): string =>
  `<section class="day">${dayHead(group)}<ol class="sessions" role="list">${group.sessions.map((session) => historyRow(session, labels)).join("")}</ol></section>`;

// Only the values the account actually holds get a chip, plus the one that is active, so a filter
// never offers a row that cannot exist.
const offered = (values: string[], active: string): string[] => {
  const present = new Set(values.filter((value) => value !== ""));
  if (active !== "") present.add(active);
  return [...present].sort();
};

const HISTORY_LIST_PARAMS = ["q", SORT_PARAM, CURSOR_PARAM, ...HISTORY_PARAMS] as const;

const chipsOf = (values: string[], names: Map<string, string>): ListingChip[] =>
  values.map((value) => ({ value, label: labelled(names, value) }));

const historyEmpty = (query: string, filtered: boolean): { headline: string; hint: string } => {
  if (query !== "") {
    return { headline: "No session matches this search.", hint: "Clear the search to read every session." };
  }
  if (filtered) {
    return {
      headline: "No session matches this filter.",
      hint: "Clear the filter to read every host and every repo.",
    };
  }
  return {
    headline: "No session is in your history yet.",
    hint: "A session lands here as soon as it syncs, and stays forever.",
  };
};

export const historyPage = (
  email: string,
  live: Live,
  url: URL,
  filter: HistoryInput,
  known: HistoryFilters,
  sessions: PastSession[],
  nextCursor: string,
  cut: boolean,
  labels: Labels,
): Response => {
  const query = url.searchParams.get("q") ?? "";
  const filtered = filter.host !== "" || filter.repo !== "";
  const groups = byDay(sessions);
  const chosen = sortInForce(url, HISTORY_SORTS);
  const listing: Listing = {
    tab: HISTORY_TAB,
    noun: { one: "session", many: "sessions" },
    params: HISTORY_LIST_PARAMS,
    search: {
      param: "q",
      placeholder: "Search sessions…",
      ariaLabel: "Search sessions",
      value: query,
      fields: [],
    },
    filters: [
      {
        param: "host",
        ariaLabel: "Filter by host",
        allLabel: "All hosts",
        active: filter.host,
        chips: chipsOf(offered(known.hosts, filter.host), labels.hosts),
      },
      {
        param: "repo",
        ariaLabel: "Filter by repo",
        allLabel: "All repos",
        active: filter.repo,
        chips: chipsOf(offered(known.repos, filter.repo), new Map()),
      },
    ],
    sorts: HISTORY_SORTS,
    sort: chosen.sort,
    unknownSort: chosen.unknownSort,
    rows:
      groups.length === 0 ? "" : `<div class="hist">${groups.map((group) => dayBlock(group, labels)).join("")}</div>`,
    empty: historyEmpty(query, filtered),
    nextCursor,
    cut,
  };
  return shell(email, HISTORY_TAB, live, HISTORY_TAB.label, "kept forever", listingMain(url, listing));
};

const MEMORY_LIST_PARAMS = ["q", SORT_PARAM, CURSOR_PARAM, ...LIST_PARAMS] as const;

const memoryChips = (filter: ListInput, counts: MemoryCounts): ListingChip[] => {
  const active = filter.types[0] ?? "";
  const counted = new Map(counts.byType.map((entry) => [entry.type, entry.count]));
  return memoryTypes
    .filter((type) => counted.has(type) || type === active)
    .map((type) => ({ value: type, label: `${type} ${counted.get(type) ?? 0}` }));
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

const memoryTotal = (counts: MemoryCounts): string => `${counts.total} ${counts.total === 1 ? "memory" : "memories"}`;

// The counts strip and the cards are Memory's own rows, so they ride inside the component rather
// than around it, and the strip keeps the place it already had under the toolrow.
const memoryRows = (counts: MemoryCounts, cards: string[]): string =>
  cards.length === 0 ? "" : `${countsStrip(counts)}<ol class="memories" role="list">${cards.join("")}</ol>`;

// The tag box is the one field in any toolrow that is neither the search nor a chip: a tag is free
// text and a chip group holds a fixed set, so it rides the search form as a field of its own.
const memoryListing = (
  url: URL,
  filter: ListInput,
  counts: MemoryCounts,
  rows: string,
  empty: { headline: string; hint: string },
  nextCursor: string,
): Listing => {
  const chosen = sortInForce(url, MEMORY_SORTS);
  return {
    tab: MEMORY_TAB,
    noun: { one: "memory", many: "memories" },
    params: MEMORY_LIST_PARAMS,
    search: {
      param: "q",
      placeholder: "Search memories…",
      ariaLabel: "Search memories",
      value: url.searchParams.get("q") ?? "",
      fields: [{ param: "tag", placeholder: "tag", ariaLabel: "Filter by tag", value: filter.tags[0] ?? "" }],
    },
    filters: [
      {
        param: "type",
        ariaLabel: "Filter by type",
        allLabel: `All ${counts.total}`,
        active: filter.types[0] ?? "",
        chips: memoryChips(filter, counts),
      },
    ],
    sorts: MEMORY_SORTS,
    sort: chosen.sort,
    unknownSort: chosen.unknownSort,
    rows,
    empty,
    nextCursor,
    cut: false,
  };
};

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
  const listing = memoryListing(
    url,
    filter,
    counts,
    memoryRows(
      counts,
      memories.map((memory) => memoryCard(memory, now, "")),
    ),
    { headline: "No memory is saved yet.", hint: "Save one with recall save." },
    nextCursor,
  );
  return shell(email, MEMORY_TAB, live, MEMORY_TAB.label, memoryTotal(counts), listingMain(url, listing));
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
  const listing = memoryListing(
    url,
    filter,
    counts,
    memoryRows(
      counts,
      hits.map((hit) => memoryCard(hit.memory, now, hit.score.toFixed(3))),
    ),
    { headline: "No memory matches this search.", hint: "Clear the search to read every memory." },
    "",
  );
  return shell(email, MEMORY_TAB, live, MEMORY_TAB.label, memoryTotal(counts), listingMain(url, listing));
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

const splitTable = (
  heading: string,
  field: UsageSplitField,
  splits: UsageSplit[],
  names: Map<string, string>,
): string => {
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
        `<tr><td>${escapeHtml(row.value === "" ? "global" : labelled(names, row.value))}</td><td class="r">${tokens(countedTokens(row.counts))}</td><td class="r">${escapeHtml(splitCost(row.cost, row.priced, row.models))}</td></tr>`,
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

export const statsPage = (email: string, live: Live, stats: Stats, labels: Labels, now: number): Response => {
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
${frame("By account", `${USAGE_MONTH_DAYS} days`, splitTable("Account", "account", stats.splits, labels.accounts))}
${frame("By host", `${USAGE_MONTH_DAYS} days`, splitTable("Host", "host", stats.splits, labels.hosts))}
</div>
${frame("By repo", `${USAGE_MONTH_DAYS} days`, splitTable("Repo", "repo", stats.splits, new Map()))}`;

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

// How many bytes of the file the browser pulls down at a time: once on opening the page, and once
// more each time the reader scrolls back past the top of the box. The bound is bytes and never
// turns, because the machinery a transcript is mostly made of — tool calls, results, file
// snapshots — is what the fetch pays for and the prose is what survives it.
export const TRANSCRIPT_STEP_BYTES = 65_536;

// The quickest the box asks a session still being written how far its file now reaches. It
// matches the beat a host archives on, so a turn shows about as soon as the archive holds it, and
// a beat that finds nothing new costs one indexed row read and opens no object. The box slows
// itself down from here while nothing arrives and comes back to this pace the moment some does.
export const TRANSCRIPT_FOLLOW_MS = 10_000;

// What the page knows about one transcript file. A session with nothing archived and a session
// asked for a file it never wrote are different answers, and the page says which rather than
// handing the browser a manifest of no stretches.
export type TranscriptPlan =
  | { kind: "none" }
  | { kind: "missing"; file: string; files: string[] }
  | { kind: "read"; file: string; files: string[]; bytes: number; runs: Run[] };

// What the send box has to say for itself after a post, and nothing when it has nothing.
export type Flash = { tone: "sent" } | { tone: "refused"; text: string };

export interface SessionSend {
  csrf: string;
  draft: string;
  flash: Flash | null;
}

export interface SessionView {
  session: PastSession;
  /// The device the session is live on, and null once its host has let the session go.
  deviceId: string | null;
  spend: SessionSpend[];
  transcript: TranscriptPlan;
  send: SessionSend;
}

const moment = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ");

const sessionState = (session: PastSession, now: number): string => {
  if (!session.running) return `ended · last activity ${age(session.lastActivityAt, now)} ago`;
  return isBusy(session, now) ? "busy" : `idle ${age(session.lastActivityAt, now)}`;
};

const factsCard = (view: SessionView, labels: Labels, now: number): string => {
  const { session } = view;
  const accounts = [...new Set(view.spend.map((row) => row.account))].filter((account) => account !== "");
  const counted = view.spend.reduce((sum, row) => sum + countedTokens(row), 0);
  const facts = [
    { name: "State", value: sessionState(session, now), warn: !session.running },
    { name: "Host", value: labelled(labels.hosts, session.host), warn: false },
    { name: "Scope", value: repoAtBranch(session.repo, session.branch), warn: false },
    { name: "Directory", value: session.cwd, warn: false },
    { name: "Started", value: `${moment(session.startedAt)} · ${age(session.startedAt, now)} ago`, warn: false },
    { name: "Prompts", value: String(session.prompts), warn: false },
    { name: "Session id", value: session.sessionId, warn: false },
  ];
  if (session.agentName !== "") facts.splice(1, 0, { name: "Named", value: session.agentName, warn: false });
  if (accounts.length > 0) {
    facts.push({
      name: accounts.length === 1 ? "Account" : "Accounts",
      value: accounts.map((account) => labelled(labels.accounts, account)).join(", "),
      warn: false,
    });
  }
  if (view.spend.length > 0) {
    facts.push({ name: "Tokens", value: tokens(counted), warn: false });
    facts.push({ name: "Cost", value: totalCost(view.spend), warn: false });
  }
  const unmetered =
    view.spend.length > 0
      ? ""
      : '<p class="callout">No usage is on record for this session. A raw reading is kept for two weeks after the server took it, and longer only where it was read back out of the transcript.</p>';
  return insightCard(session.name, repoAtBranch(session.repo, session.branch), `${insightList(facts)}${unmetered}`);
};

// The bus reaches a session for as long as its host holds it, which is a day after its last
// prompt and not the five minutes that separate busy from idle. A session idle for hours is still
// addressable, and the copy says what delivery actually depends on rather than promising a turn
// the host may never take.
const SEND_WINDOW = "the bus reaches a session its host still holds";

const flashHtml = (flash: Flash | null, name: string): string => {
  if (flash === null) return "";
  if (flash.tone === "refused") return `<p class="flash bad">${escapeHtml(flash.text)}</p>`;
  return `<p class="flash">Sent to <strong>${escapeHtml(name)}</strong>. Its host hands it to the session as the next turn, unless its host was not listening, in which case nothing was kept and nobody read it.</p>`;
};

const sendCard = (view: SessionView): string => {
  const { session } = view;
  const flash = flashHtml(view.send.flash, session.name);
  if (view.deviceId === null) {
    return insightCard(
      "Send a message",
      SEND_WINDOW,
      `${flash}<p class="callout">No host is running this session any more, so the bus has nowhere to deliver. A message reaches a session until a day after its last prompt, while its host still holds it.</p>`,
    );
  }
  return insightCard(
    "Send a message",
    SEND_WINDOW,
    `${flash}<form class="send" method="post" action="${escapeHtml(sessionPath(session.sessionId))}">
<input type="hidden" name="csrf" value="${escapeHtml(view.send.csrf)}">
<textarea name="body" rows="4" required placeholder="What should this session read next?" aria-label="Message to this session">${escapeHtml(view.send.draft)}</textarea>
<button type="submit">Send</button></form>`,
  );
};

const fileChips = (sessionId: string, files: string[], file: string): string => {
  if (files.length < 2) return "";
  return `<nav class="chips" aria-label="Transcript files">${files
    .map(
      (held) =>
        `<a href="${sessionLink(sessionId, { file: held })}"${held === file ? ' aria-current="page"' : ""}>${escapeHtml(held)}</a>`,
    )
    .join("")}</nav>`;
};

export const TRANSCRIPT_SEGMENT = "transcript";

// The script the box runs. It is the same file for every reader, so the page names it instead of
// carrying it, and the policy can name an origin rather than an inline script. It sits outside
// `/dashboard` because the Access application that gates the browser pages is scoped to that path
// and `/device`: a tab woken from bfcache after the sign-in ran out would get a login redirect for
// the script, and `script-src 'self'` leaves the page no way to notice. The script carries code
// and no user data, so the hostname-wide bypass is the right gate for it.
export const TRANSCRIPT_SCRIPT_PATH = "/transcript.js";

export const transcriptScript = (): Response =>
  new Response(TRANSCRIPT_SCRIPT, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });

// A `</script` anywhere in the manifest would close the element early; escaping the one character
// that can open it keeps the JSON valid and the element whole.
const planJson = (plan: unknown): string => JSON.stringify(plan).replaceAll("<", "\\u003c");

// A hole is a run of bytes the archive never got, which is what a stretch written past the end of
// the file leaves behind — including one in front of the first stretch, where a file whose
// archiving began late has no beginning at all. The entry that straddles a hole cannot be read,
// and saying so is what keeps a reader from taking the entries either side of it for the whole
// conversation.
const holeNote = (listing: RunListing): string => {
  const { bytes, places } = gapsIn(listing);
  if (bytes === 0) return "";
  return `<p class="callout">The archive never got ${bytes} bytes of this file, in ${places} ${places === 1 ? "place" : "places"}. Whatever entry each gap falls inside is not shown.</p>`;
};

// What a manifest held back says for itself. The reader is told the box stops short of the start
// of the file rather than being left to read the oldest turn it shows as the first one there was.
const trimNote = (listing: RunListing, bytes: number): string =>
  listing.from === 0
    ? ""
    : `<p class="callout">This file runs to ${sizeText(bytes)}. The last ${sizeText(bytes - listing.from)} of it is listed here; the stretches before that are not, so the box stops short of the start of the session.</p>`;

// What the box follows, and nothing when there is nothing to follow. `from` is the end of the
// manifest, which is the first byte the box has not been handed, so following starts where the
// page stops and no byte is read twice. A session no host is holding writes nothing more, and
// whether one is holding it is the fact the beat itself answers with, so the page that starts
// following and the beat that ends it cannot disagree about what live means. Only the session's
// own file keeps an extent cheap enough to beat against.
const followOf = (view: SessionView, file: string, bytes: number): Follow | null =>
  view.deviceId !== null && file === MAIN_FILE ? { from: bytes, every: TRANSCRIPT_FOLLOW_MS } : null;

const transcriptCard = (view: SessionView): string => {
  const held = view.transcript;
  const id = view.session.sessionId;
  if (held.kind === "none") {
    return insightCard(
      "Transcript",
      "nothing archived",
      emptyState(
        "No transcript is archived for this session.",
        "A host archives a session's transcript as it runs, and the stretches land here within a minute of the prose.",
      ),
    );
  }
  if (held.kind === "missing") {
    return insightCard(
      "Transcript",
      `${held.files.length} ${held.files.length === 1 ? "file" : "files"}`,
      `${fileChips(id, held.files, held.file)}${emptyState(`This session has no ${held.file} on record.`, "Pick one of the files it did archive.")}`,
    );
  }
  const listing = listedRuns(held.runs);
  const plan: Plan = {
    path: `${sessionPath(id)}/${TRANSCRIPT_SEGMENT}`,
    file: held.file,
    readable: listing.readable,
    step: TRANSCRIPT_STEP_BYTES,
    runs: listing.runs,
    follow: followOf(view, held.file, held.bytes),
  };
  return insightCard(
    "Transcript",
    `${held.file} · ${sizeText(held.bytes)}`,
    `${fileChips(id, held.files, held.file)}${trimNote(listing, held.bytes)}${holeNote(listing)}
<div class="scroller" id="tx" tabindex="0" aria-label="Transcript">
<p class="txtop"><button type="button" id="txmore">Load earlier</button></p>
<ol class="turns" id="txlist" role="list"></ol></div>
<p class="txnote" id="txnote">Reading ${escapeHtml(held.file)}…</p>
<p class="txnote" id="txtail"></p>
<noscript><p class="callout">The transcript is read by the browser straight off the archive, so this box stays empty while scripts are off.</p></noscript>
<script type="application/json" id="txplan">${planJson(plan)}</script>
<script src="${TRANSCRIPT_SCRIPT_PATH}" defer></script>`,
  );
};

export const sessionPage = (
  email: string,
  live: Live,
  view: SessionView,
  labels: Labels,
  now: number,
  status = 200,
): Response => {
  const { session } = view;
  const cookies = [`${CSRF_COOKIE}=${view.send.csrf}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict`];
  if (view.send.flash?.tone === "sent") {
    cookies.push(`${SENT_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);
  }
  return shell(
    email,
    SESSIONS_TAB,
    live,
    session.name,
    `${labelled(labels.hosts, session.host)} · ${sessionState(session, now)}`,
    `<p class="lede">${focusHtml(session.focus)}</p>
<div class="charts duo">${factsCard(view, labels, now)}${sendCard(view)}</div>
${transcriptCard(view)}
<p class="more"><a href="${SESSIONS_TAB.path}">Back to the sessions</a></p>`,
    { "set-cookie": cookies, "content-security-policy": SCRIPT_CSP },
    status,
  );
};

export const ARTIFACT_LIST_PARAMS = ["q", "type", SORT_PARAM, CURSOR_PARAM, "limit"] as const;

export interface ArtifactTypeCount {
  type: ArtifactType;
  count: number;
}

// One read of the rows and one read of the counts the chips print, which is what a page of any
// list in the dashboard costs.
export interface ArtifactCounts {
  total: number;
  byType: ArtifactTypeCount[];
}

// One page of the shelf. A search answers a bounded match set in relevance order and sets `cut`
// when it had more to give; a paged walk answers a cursor instead. The two never both apply.
export interface ArtifactShelf {
  artifacts: ArtifactView[];
  counts: ArtifactCounts;
  nextCursor: string;
  cut: boolean;
}

// What the tab has to show. A deployment naming no artifact hostname publishes nothing at all,
// which is a different answer from an account that has published nothing yet; the page says which
// rather than drawing the same empty shelf for both.
export type Published = { kind: "off" } | { kind: "shelf"; shelf: ArtifactShelf };

const ARTIFACT_HEAD =
  '<li class="srow arow lhead" aria-hidden="true"><span>Artifact</span><span>Type</span><span class="r">Size</span><span class="r">Published</span><span>Access</span><span>Last writer</span></li>';

const fileCount = (artifact: ArtifactView): string => {
  if (artifact.fileCount < 2) return "";
  return `${artifact.fileCount} ${artifact.type === "audio" ? "tracks" : "files"}`;
};

// The count of live shares is itself the control that opens the share page, so a reader reads what
// is shared and reaches it in one place. It carries the artifact's name in its accessible name, or
// twenty rows read as twenty links all called `3 shares`.
const shareCell = (artifact: ArtifactView): string => {
  const { shareCount, name } = artifact;
  const text = shareCount === 0 ? "Share" : `${shareCount} ${shareCount === 1 ? "share" : "shares"}`;
  const label = shareCount === 0 ? `Share ${name}` : `${text} on ${name}`;
  return `<span class="ash"><a href="${escapeHtml(sharesPath(name))}" aria-label="${escapeHtml(label)}">${escapeHtml(text)}</a></span>`;
};

// An artifact answers on the artifact hostname, behind its own Access application, so the name
// opens in a tab of its own rather than taking the dashboard's. The share link stays in this tab:
// the share page is a dashboard page and no sign-in is crossed.
const artifactRow = (artifact: ArtifactView): string => {
  const title = artifact.title === artifact.name ? "" : `<span class="atitle">${escapeHtml(artifact.title)}</span>`;
  const count = fileCount(artifact);
  return `<li class="srow arow"><p class="h"><b><a href="${escapeHtml(artifact.url)}" target="_blank" rel="noreferrer">${escapeHtml(artifact.name)}</a></b>${title}</p>
<p class="smeta"><span class="aty">${escapeHtml(artifact.type)}</span>${count === "" ? "" : `<span class="afc">${escapeHtml(count)}</span>`}<span class="ab">${escapeHtml(sizeText(artifact.bytes))}</span><span class="at">${escapeHtml(moment(artifact.updatedAt))}</span><span class="ard">${escapeHtml(`r ${artifact.read}`)}</span><span class="awr">${escapeHtml(`w ${artifact.write}`)}</span><span class="alw">${escapeHtml(artifact.lastWriter)}</span>${shareCell(artifact)}</p></li>`;
};

const artifactEmpty = (query: string, type: string): { headline: string; hint: string } => {
  if (query !== "") {
    return { headline: "No artifact matches this search.", hint: "Clear the search to read every artifact." };
  }
  if (type !== "") {
    return { headline: "No artifact matches this filter.", hint: "Clear the filter to read every artifact." };
  }
  return {
    headline: "No artifact is published yet.",
    hint: "Publish one with recall publish, and it lands here with the address it answers on.",
  };
};

// Only the types the shelf actually holds get a chip, plus the one that is active: a filter that
// empties its own count has to keep its chip, or the reader cannot see it or clear it.
const artifactChips = (counts: ArtifactCounts, active: string): ListingChip[] => {
  const counted = new Map(counts.byType.map((entry) => [entry.type, entry.count]));
  return artifactTypes
    .filter((type) => counted.has(type) || type === active)
    .map((type) => ({ value: type, label: `${type} ${counted.get(type) ?? 0}` }));
};

const artifactMeta = (shown: number, counts: ArtifactCounts, narrowed: boolean): string => {
  const noun = counts.total === 1 ? "artifact" : "artifacts";
  return narrowed ? `${shown} of ${counts.total} ${noun}` : `${counts.total} ${noun}`;
};

export const artifactsPage = (email: string, live: Live, url: URL, published: Published): Response => {
  if (published.kind === "off") {
    return shell(
      email,
      ARTIFACTS_TAB,
      live,
      ARTIFACTS_TAB.label,
      "not enabled",
      `<div class="notice"><b>This deployment publishes no artifacts.</b>
<p>It names no artifact hostname, so there is no second host to serve an artifact from and nothing here to browse. Naming one and deploying turns publishing on.</p></div>`,
    );
  }
  const { artifacts, counts, nextCursor, cut } = published.shelf;
  const query = url.searchParams.get("q") ?? "";
  const type = url.searchParams.get("type") ?? "";
  const chosen = sortInForce(url, ARTIFACT_SORTS);
  const typeFilter: ListingFilter = {
    param: "type",
    ariaLabel: "Filter by type",
    allLabel: `All ${counts.total}`,
    active: type,
    chips: artifactChips(counts, type),
  };
  const listing: Listing = {
    tab: ARTIFACTS_TAB,
    noun: { one: "artifact", many: "artifacts" },
    params: ARTIFACT_LIST_PARAMS,
    search: {
      param: "q",
      placeholder: "Search artifacts…",
      ariaLabel: "Search artifacts",
      value: query,
      fields: [],
    },
    filters: [typeFilter],
    sorts: ARTIFACT_SORTS,
    sort: chosen.sort,
    unknownSort: chosen.unknownSort,
    rows:
      artifacts.length === 0
        ? ""
        : `<ol class="sessions" role="list">${ARTIFACT_HEAD}${artifacts.map(artifactRow).join("")}</ol>`,
    empty: artifactEmpty(query, type),
    nextCursor,
    cut,
  };
  return shell(
    email,
    ARTIFACTS_TAB,
    live,
    ARTIFACTS_TAB.label,
    artifactMeta(artifacts.length, counts, query !== "" || type !== ""),
    listingMain(url, listing),
  );
};

export const SHARES_SEGMENT = "shares";

export const sharesPath = (name: string): string =>
  `${ARTIFACTS_TAB.path}/${encodeURIComponent(name)}/${SHARES_SEGMENT}`;

// What the share page has to say for itself after a mutation, and nothing when it has nothing.
export type ShareFlash = { tone: "done"; text: string } | { tone: "refused"; text: string };

// The address a mutation minted, printed on that one response. A link share's token exists here and
// nowhere else, which is why the block carries the whole address and never a shortened one.
export type Minted =
  | { mode: "link"; address: string; expiresAt: number }
  | { mode: "email"; address: string; recipient: string; expiresAt: number };

// A question the page is asking. Each rides the query, so each is bookmarkable and Back dismisses
// it; a revoke naming no live share is not an ask at all, and the page says so in its flash.
export type ShareAsk =
  | { kind: "relink" }
  | { kind: "revoke"; share: ShareView }
  | { kind: "revoke-all"; count: number };

export interface SharePage {
  artifact: ArtifactView;
  shares: ShareView[];
  csrf: string;
  flash: ShareFlash | null;
  minted: Minted | null;
  ask: ShareAsk | null;
  emailDraft: string;
  emailFull: boolean;
  now: number;
}

// Three answers the share page gives, and only the third holds an artifact: a deployment that
// binds no share audience and an artifact another account owns both print the name the reader
// typed and nothing else about it.
export type Shares = { kind: "off" } | { kind: "foreign" } | { kind: "page"; page: SharePage };

// The name the reader asked for, as the address holds it. A share page is only reached at
// `<artifacts>/<name>/shares`, and the segment is printed rather than decoded so that a state
// drawn for no artifact — W34's and W35's — echoes the address unrewritten.
const askedName = (url: URL): string => {
  const segments = url.pathname.replace(/\/$/, "").split("/");
  return segments[segments.length - 2] ?? "";
};

// A share's unit is the day, so created and expires are dates. Last opened is a relative age, the
// way a session row prints one.
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

const shareTally = (count: number): string =>
  count === 0 ? "no shares" : `${count} ${count === 1 ? "share" : "shares"}`;

const backToArtifacts = `<p class="more"><a href="${ARTIFACTS_TAB.path}">Back to the artifacts</a></p>`;

const SHARE_HEAD =
  '<li class="srow shrow lhead" aria-hidden="true"><span>Recipient</span><span>Created</span><span>Expires</span><span>Last opened</span><span class="r">Opens</span><span></span></li>';

const recipientOf = (share: ShareView): string => (share.mode === "link" ? "Anyone with the link" : share.address);

const revokeName = (share: ShareView): string =>
  share.mode === "link" ? "Revoke the link share" : `Revoke the share with ${share.address}`;

const lastOpened = (share: ShareView, now: number): string =>
  share.uses === 0 ? "never opened" : `${age(share.lastUsedAt, now)} ago`;

// An inert control keeps its place in the tab order and loses only its action, and it carries the
// question as its description: a control that drops out hides the reason from the reader who most
// needs it.
const revokeControl = (share: ShareView, path: string, inert: boolean): string => {
  const label = escapeHtml(revokeName(share));
  if (inert) {
    return `<span class="sctl" tabindex="0" role="link" aria-disabled="true" aria-label="${label}" aria-describedby="askwhy">Revoke</span>`;
  }
  return `<a class="sctl" href="${escapeHtml(`${path}?revoke=${encodeURIComponent(share.shareId)}`)}" aria-label="${label}">Revoke</a>`;
};

// Six fields and one control. The header row is aria-hidden, so a screen reader reads the rows and
// not the labels, and each field names itself at phone width where the header is gone.
const shareRow = (share: ShareView, path: string, now: number, ask: ShareAsk | null): string => {
  const asking = ask !== null;
  const going = ask?.kind === "revoke-all" || (ask?.kind === "revoke" && ask.share.shareId === share.shareId);
  const questioned = ask?.kind === "revoke" && ask.share.shareId === share.shareId;
  const mark = ask === null || ask.kind === "relink" ? "" : going ? "going" : "kept";
  const left = shareTimeLeft(share.expiresAt, now);
  return `<li class="srow shrow"><p class="h"><b>${escapeHtml(recipientOf(share))}</b><span class="smode">${escapeHtml(
    questioned ? `${share.mode} · the one in question` : share.mode,
  )}</span></p>
<p class="smeta"><span class="scr"><span class="unit">created </span>${escapeHtml(day(share.createdAt))}</span><span class="sex"><span class="unit">expires </span>${escapeHtml(
    day(share.expiresAt),
  )}${left === "" ? "" : `<span class="sleft">${escapeHtml(left)}</span>`}</span></p>
<p class="smeta"><span class="slo">${escapeHtml(lastOpened(share, now))}</span><span class="sus">${share.uses}<span class="unit"> ${
    share.uses === 1 ? "open" : "opens"
  }</span></span></p>
<p class="srev">${revokeControl(share, path, asking)}${mark === "" ? "" : `<span class="smark">${mark}</span>`}</p></li>`;
};

const csrfField = (csrf: string): string => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;

// The primary control: one named address, proven by a one-time PIN and revocable by name. It is
// drawn first, its submit is the filled one, and its field holds focus when nothing else claims it.
// The judge of an address is the server, so the field takes no type the browser validates itself —
// a refusal the page never serves is a refusal the owner cannot read.
const emailForm = (page: SharePage, path: string, focused: boolean): string => {
  const described = page.emailFull
    ? ' aria-describedby="sfull"'
    : page.flash?.tone === "refused"
      ? ' aria-describedby="sflash"'
      : "";
  const submit = page.emailFull
    ? '<button class="sgo" type="button" aria-disabled="true" aria-describedby="sfull">Share by email</button>'
    : '<button class="sgo" type="submit" name="do" value="email">Share by email</button>';
  return `<form class="scre" method="post" action="${escapeHtml(path)}">${csrfField(page.csrf)}
<h2>Share with one address</h2>
<input name="address" inputmode="email" autocomplete="off" maxlength="254" value="${escapeHtml(
    page.emailDraft,
  )}" placeholder="reader@example.com" aria-label="Address to share with"${described}${focused ? " autofocus" : ""}>
${submit}</form>`;
};

// The deliberate second choice: a link is a secret address that works for whoever ends up holding
// it. Replacing is a question first, because the address in use dies the moment the new one is
// made; extending keeps the address and the token and moves only the expiry.
const linkForm = (page: SharePage, path: string, link: ShareView | undefined): string => {
  const controls =
    link === undefined
      ? '<button class="sctl" type="submit" name="do" value="link">Create a link</button>'
      : `<a class="sctl" href="${escapeHtml(`${path}?relink=1`)}">Replace the link</a><button class="sctl" type="submit" name="do" value="extend">Extend by ${SHARE_DAYS} days</button>`;
  return `<form class="scre" method="post" action="${escapeHtml(path)}">${csrfField(page.csrf)}
<h2>Share with a link</h2>
<p class="slinks">${controls}</p></form>`;
};

// The one response the address exists on. It is printed whole and wrapped onto as many lines as it
// takes: an address with a piece missing cannot be copied, and for a link there is no second
// chance to read it.
const mintedBlock = (minted: Minted, now: number): string => {
  const days = Math.max(1, Math.round((minted.expiresAt - now) / DAY_MS));
  const stops = `It stops working on ${day(minted.expiresAt)}, ${days} ${days === 1 ? "day" : "days"} from now.`;
  const head =
    minted.mode === "link"
      ? "The link is made. This is the only time this address is shown."
      : `The share with ${minted.recipient} is made. Send them this address.`;
  const tail =
    minted.mode === "link"
      ? `${stops} Revoking it, or making a second link, retires it the moment you do.`
      : `${stops} Only ${minted.recipient} opens it, after proving that address with a one-time code.`;
  return `<div class="minted"><b id="sminted" tabindex="-1" autofocus>${escapeHtml(head)}</b>
<p class="maddr">${escapeHtml(minted.address)}</p>
<p>${escapeHtml(tail)}</p></div>`;
};

interface Question {
  head: string;
  why: string;
  confirm: string;
  action: string;
  share: string;
}

const questionOf = (ask: ShareAsk, name: string): Question => {
  if (ask.kind === "relink") {
    return {
      head: "Replace the link share?",
      why: "The address in use stops working the moment the new one is made. Anyone holding it gets the page that says the share is no longer available, and there is no way to hand the old address back.",
      confirm: "Replace the link",
      action: "relink",
      share: "",
    };
  }
  if (ask.kind === "revoke-all") {
    const { count } = ask;
    return {
      head: `Revoke all ${count} ${count === 1 ? "share" : "shares"} on ${name}?`,
      why: "Every address and every link stops reading it. The page then says the artifact is shared with nobody and keeps both create controls. There is no undo and no way to hand an address back.",
      confirm: `Revoke all ${count}`,
      action: "revoke-all",
      share: "",
    };
  }
  const { share } = ask;
  if (share.mode === "link") {
    return {
      head: "Revoke the link share?",
      why: "The address stops working. Its next open answers the page that says the share is no longer available, and there is no way to hand it back. Creating a link again makes a new address, with a new 30 days.",
      confirm: "Revoke the link",
      action: "revoke",
      share: share.shareId,
    };
  }
  return {
    head: `Revoke the share with ${share.address}?`,
    why: `That address stops reading this artifact. Its next open answers the page that says the share is no longer available. Sharing with ${share.address} again makes a new share, with a new ${SHARE_DAYS} days.`,
    confirm: "Revoke the share",
    action: "revoke",
    share: share.shareId,
  };
};

// A question is a page state named in the query, not an overlay: it is bookmarkable, it reloads to
// the same question, and Back dismisses it. Nothing is layered over the page, so there is no
// click-outside and no Esc to trap.
const askBlock = (ask: ShareAsk, page: SharePage, path: string): string => {
  const question = questionOf(ask, page.artifact.name);
  const share = question.share === "" ? "" : `<input type="hidden" name="share" value="${escapeHtml(question.share)}">`;
  return `<div class="notice ask"><b id="sask" tabindex="-1" autofocus>${escapeHtml(question.head)}</b>
<p id="askwhy">${escapeHtml(question.why)}</p>
<div class="sacts"><form method="post" action="${escapeHtml(path)}">${csrfField(page.csrf)}${share}
<button class="sgo" type="submit" name="do" value="${question.action}">${escapeHtml(question.confirm)}</button></form><a class="sctl" href="${escapeHtml(path)}">Keep it</a></div></div>`;
};

const flashBlock = (flash: ShareFlash, focused: boolean): string =>
  `<p class="flash${flash.tone === "refused" ? " bad" : ""}" id="sflash"${focused ? ' tabindex="-1" autofocus' : ""}>${escapeHtml(
    flash.text,
  )}</p>`;

// A full artifact says so above the form, and the card names the scope: an owner who reads "twenty
// shares" with no scope assumes the whole deployment has stopped sharing.
const fullCard = `<div class="notice" id="sfull"><b>${escapeHtml(
  `This artifact holds ${MAX_EMAIL_SHARES} email shares, the most one takes.`,
)}</b><p>${escapeHtml(
  "Revoke one and the form takes another address. The limit is per artifact, so another artifact still shares. A link share does not count against it.",
)}</p></div>`;

const identity = (artifact: ArtifactView): string =>
  `<p class="lede">${escapeHtml(artifact.title)}</p>
<p class="smeta"><span>${escapeHtml(artifact.type)}</span><span>${escapeHtml(sizeText(artifact.bytes))}</span><span>${escapeHtml(
    `published ${moment(artifact.updatedAt)}`,
  )}</span><span>${escapeHtml(`r ${artifact.read}`)}</span><span>${escapeHtml(`w ${artifact.write}`)}</span></p>
<p class="sopen"><a href="${escapeHtml(artifact.url)}" target="_blank" rel="noreferrer">Open the artifact</a></p>`;

// Drawn only when the artifact is read private, so an owner does not conclude a private artifact
// cannot be shared.
const permissionLine = (artifact: ArtifactView): string =>
  artifact.read === "private"
    ? `<p class="callout">${escapeHtml(
        "A share works whatever the read permission says. This artifact is read private and a reader holding a share still reads it.",
      )}</p>`
    : "";

// Exactly one element on the page carries autofocus. A question outranks everything, a minted
// address outranks the rest, and a refused address hands focus back to the field it came from with
// the flash as its description. Nothing else moves focus, because no script runs on any of it.
type Focused = "ask" | "minted" | "flash" | "field";

const focusedOn = (page: SharePage): Focused => {
  if (page.ask !== null) return "ask";
  if (page.minted !== null) return "minted";
  if (page.flash === null) return "field";
  return page.flash.tone === "refused" && page.emailDraft !== "" ? "field" : "flash";
};

const sharesMain = (page: SharePage, path: string): string => {
  const { artifact, shares, ask, now } = page;
  const focus = focusedOn(page);
  const link = shares.find((share) => share.mode === "link");
  const minted = page.minted === null ? "" : mintedBlock(page.minted, now);
  const flash = page.flash === null ? "" : flashBlock(page.flash, focus === "flash");
  const question = ask === null ? "" : askBlock(ask, page, path);
  const controls = ask === null ? `${emailForm(page, path, focus === "field")}${linkForm(page, path, link)}` : "";
  const full = ask === null && page.emailFull ? fullCard : "";
  const list =
    shares.length === 0
      ? emptyState(
          `${artifact.name} is shared with nobody.`,
          `Share it with one address, or create a link anyone holding it opens. Every share expires ${SHARE_DAYS} days after it is made.`,
        )
      : `<ol class="sessions" role="list">${SHARE_HEAD}${shares.map((share) => shareRow(share, path, now, ask)).join("")}</ol>`;
  const all =
    ask === null && shares.length > 1
      ? `<p class="slinks"><a class="sctl" href="${escapeHtml(`${path}?revoke=all`)}" aria-label="${escapeHtml(
          `Revoke every share on ${artifact.name}`,
        )}">Revoke every share</a></p>`
      : "";
  return `${identity(artifact)}${permissionLine(artifact)}${minted}${flash}${full}${question}${controls}${list}${all}${backToArtifacts}`;
};

// One page per artifact, reached from that artifact's row in the Artifacts tab and from the owner's
// bar on the artifact itself, with Artifacts current in the nav throughout. No script runs on any
// state of it: every question is a GET that redraws this page and every mutation is a POST to it.
export const sharesPage = (email: string, live: Live, url: URL, shares: Shares, status = 200): Response => {
  if (shares.kind === "off") {
    return sharesShell(
      email,
      live,
      askedName(url),
      "not enabled",
      `<div class="notice"><b>${escapeHtml("Sharing is not configured for this deployment.")}</b><p>${escapeHtml(
        "It binds no audience for the share Access application, so there is no second sign-in to prove a recipient with, and a share address has nothing to answer with. Naming ARTIFACT_SHARE_ACCESS_AUD and deploying turns sharing on.",
      )}</p></div>${backToArtifacts}`,
      status,
    );
  }
  if (shares.kind === "foreign") {
    return sharesShell(
      email,
      live,
      askedName(url),
      "not yours",
      `<div class="notice"><b>${escapeHtml("Only an artifact's owner shares it.")}</b><p>${escapeHtml(
        "This name belongs to another account in this recall. Its owner shares it, and the page draws no control here.",
      )}</p></div>${backToArtifacts}`,
      status === 200 ? 403 : status,
    );
  }
  const { page } = shares;
  const path = sharesPath(page.artifact.name);
  const meta =
    page.ask?.kind === "relink" ? "replacing the link" : `${page.artifact.type} · ${shareTally(page.shares.length)}`;
  return sharesShell(email, live, page.artifact.name, meta, sharesMain(page, path), status, page.csrf);
};

const sharesShell = (
  email: string,
  live: Live,
  heading: string,
  meta: string,
  main: string,
  status: number,
  csrf = "",
): Response =>
  shell(
    email,
    ARTIFACTS_TAB,
    live,
    heading,
    meta,
    main,
    csrf === ""
      ? {}
      : { "set-cookie": `${CSRF_COOKIE}=${csrf}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict` },
    status,
  );

const labelRows = (kind: LabelKind, values: string[], names: Map<string, string>): string =>
  `<ul class="lrows" role="list">${values
    .map(
      (value) =>
        `<li><span class="lv">${escapeHtml(value)}</span><input name="${escapeHtml(`${kind}:${value}`)}" value="${escapeHtml(names.get(value) ?? "")}" maxlength="${MAX_SESSION_TEXT_CHARS}" placeholder="${escapeHtml(value)}" aria-label="${escapeHtml(`Label for ${kind} ${value}`)}"></li>`,
    )
    .join("")}</ul>`;

const labelCard = (title: string, kind: LabelKind, values: string[], names: Map<string, string>): string =>
  values.length === 0
    ? ""
    : `<div class="cframe"><div class="ch"><b>${escapeHtml(title)}</b><span>${values.length} on record</span></div>${labelRows(kind, values, names)}</div>`;

export const labelsPage = (
  email: string,
  live: Live,
  targets: LabelTargets,
  labels: Labels,
  csrf: string,
): Response => {
  const main =
    targets.hosts.length + targets.accounts.length === 0
      ? emptyState(
          "No host or account is on record yet.",
          "A host lands here as soon as one of its sessions syncs, and an account as soon as a session reports what it spent.",
        )
      : `<form class="labels" method="post" action="${LABELS_TAB.path}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
${labelCard("Hosts", "host", targets.hosts, labels.hosts)}
${labelCard("Accounts", "account", targets.accounts, labels.accounts)}
<p class="lsave"><button type="submit">Save labels</button></p></form>`;
  return shell(email, LABELS_TAB, live, LABELS_TAB.label, "display only", main, {
    "set-cookie": `${CSRF_COOKIE}=${csrf}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict`,
  });
};

// One address the post form offers. The value is the resolved pair the service stores, so the page
// hands over an address rather than a string somebody has to resolve a second time.
export interface BoardOption {
  value: string;
  label: string;
}

export type BoardFlash = { tone: "posted" } | { tone: "refused"; text: string };

export interface BoardPoster {
  csrf: string;
  to: string;
  draft: string;
  flash: BoardFlash | null;
  options: BoardOption[];
}

export interface BoardView {
  entries: BoardEntry[];
  nextCursor: string;
  post: BoardPoster;
}

export const FLEET_OPTION = "fleet";

const boardFlashHtml = (flash: BoardFlash | null): string => {
  if (flash === null) return "";
  if (flash.tone === "refused") return `<p class="flash bad">${escapeHtml(flash.text)}</p>`;
  return `<p class="flash">Posted. The first session that picks it up takes it, and nobody else reads it.</p>`;
};

const boardForm = (post: BoardPoster): string =>
  `${boardFlashHtml(post.flash)}<form class="send" method="post" action="${BOARD_TAB.path}">
<input type="hidden" name="csrf" value="${escapeHtml(post.csrf)}">
<select name="to" aria-label="Who takes this message">${post.options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${option.value === post.to ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("")}</select>
<textarea name="body" rows="4" required placeholder="What should the first session to read this do?" aria-label="Message to the board">${escapeHtml(post.draft)}</textarea>
<button type="submit">Post</button></form>`;

const boardRow = (entry: BoardEntry, now: number): string => {
  const { message } = entry;
  const state =
    entry.state === "waiting"
      ? '<span class="bwait">waiting</span>'
      : `<span class="btook">${escapeHtml(`taken ${age(entry.takenBy.pickedUpAt, now)} ago by ${entry.takenBy.host}/${entry.takenBy.sessionId}`)}</span>`;
  return `<li class="srow"><p class="bbody">${escapeHtml(message.body)}</p>
<p class="smeta"><span>${escapeHtml(addressText(message))}</span><span>${escapeHtml(`from ${posterOf(message)}`)}</span><span>${escapeHtml(`${age(message.createdAt, now)} ago`)}</span>${state}</p></li>`;
};

export const boardPage = (
  email: string,
  live: Live,
  url: URL,
  view: BoardView,
  now: number,
  status = 200,
): Response => {
  const listing: Listing = {
    tab: BOARD_TAB,
    noun: { one: "message", many: "messages" },
    params: [CURSOR_PARAM],
    search: null,
    filters: [],
    sorts: [],
    sort: "",
    unknownSort: "",
    rows:
      view.entries.length === 0
        ? ""
        : `<ol class="sessions" role="list">${view.entries.map((entry) => boardRow(entry, now)).join("")}</ol>`,
    empty: {
      headline: "The board is empty.",
      hint: "Post a message here or with recall post, and the first session that picks it up takes it.",
    },
    nextCursor: view.nextCursor,
    cut: false,
  };
  const cookies = [`${CSRF_COOKIE}=${view.post.csrf}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict`];
  if (view.post.flash?.tone === "posted") {
    cookies.push(`${SENT_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);
  }
  return shell(
    email,
    BOARD_TAB,
    live,
    BOARD_TAB.label,
    `expires in ${BOARD_DAYS} days`,
    `${boardForm(view.post)}${listingMain(url, listing)}`,
    { "set-cookie": cookies },
    status,
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
