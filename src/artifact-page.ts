import { type ArtifactFile, type ArtifactRecord, RAW_INLINE_BYTES } from "./artifacts";
import { ARTIFACT_PAGE_CSP, ARTIFACT_PLAYER_CSP, escapeHtml, htmlPage, sizeText, TOKENS } from "./page";
import type { PlayerPlan } from "./player";
import { PLAYER_SCRIPT } from "./player-view.generated";
import { FILE_SEGMENT, PLAYER_SEGMENT } from "./shares";

// A document this long is not rendered: the bare address answers the raw view instead, and the
// raw page names the ceiling, the document's own size and the fix. One constant, so changing the
// number changes one string.
export const RENDER_CEILING_BYTES = 2 * 1024 * 1024;

export const RAW_VIEW = "raw";

// Where the page sits and who is reading it. Every address the module draws is built from `base`:
// an owner's page passes `/a/<name>` and a shared page passes `/link/<token>` or `/email/<id>`, so
// the three are values of one parameter rather than three cases.
export interface ArtifactChrome {
  base: string;
  audience: Audience;
}

// The band is one slot with one tenant, and the type is what makes that true: a recipient's page
// carries no dashboard address at all, so it cannot print the link even by mistake.
export type Audience =
  | { kind: "owner"; shares: number; sharesUrl: string; dashboard: string }
  | { kind: "account"; dashboard: string }
  | { kind: "recipient"; expiresAt: number };

// What a recipient can be refused with. `gone` answers every dead share alike, `elsewhere` answers
// a proven address the share does not name, and `method` answers anything but a GET.
export type ShareRefusal = { kind: "gone" } | { kind: "elsewhere"; signInAgain: string } | { kind: "method" };

const STYLE = `${TOKENS}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans)}
a{color:var(--accent)}
.abar{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.7rem 1.1rem;border-bottom:1px solid var(--line);background:var(--surface)}
.brand{margin:0;display:flex;align-items:center;font:600 .95rem/1 var(--mono);letter-spacing:.02em}
.brand i{flex:none;width:.55rem;height:.55rem;border-radius:2px;background:var(--accent);margin-right:.45rem}
.badge{font:600 .64rem/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line2);border-radius:4px;padding:.3rem .45rem}
.band{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:2.25rem;padding:.5rem 1.1rem;border-bottom:1px solid var(--line);background:var(--surface2)}
.band p{margin:0;font-size:.85rem;color:var(--dim);overflow-wrap:anywhere}
.band a{flex:none;font:600 .82rem/1 var(--sans);text-decoration:none}
.band a::after{content:" \\2197"}
.band a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wrap{max-width:52rem;margin:0 auto;padding:1.4rem 1.1rem 3rem;display:grid;gap:.9rem;align-content:start}
.wrap h1{margin:0;font-size:1.3rem;letter-spacing:-.01em;overflow-wrap:anywhere}
.adesc{margin:0;font-size:.95rem;color:var(--dim);max-width:70ch}
.ameta{margin:0;font:400 .76rem/1.5 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.views{display:flex;gap:.4rem;margin:0}
.views a,.views span{font:400 .78rem/1 var(--mono);text-decoration:none;padding:.4rem .7rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface);color:var(--dim)}
.views a[aria-current]{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.views span{border-style:dashed;color:var(--faint)}
.views a:focus-visible,.tracks button:focus-visible,.bar button:focus-visible,.bar input:focus-visible,.afoot a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.notice{display:grid;gap:.45rem;margin:0;padding:.9rem 1rem;background:var(--surface);border:1px solid var(--line2);border-left:3px solid var(--warn);border-radius:8px}
.notice b{font-size:.92rem}
.notice p{margin:0;font-size:.85rem;color:var(--dim)}
.empty{display:grid;gap:.3rem;padding:1.4rem .2rem}
.empty b{font-size:.95rem}
.empty p{margin:0;font-size:.88rem;color:var(--dim);max-width:52ch}
.doc{display:grid;gap:.85rem;overflow-wrap:anywhere}
.doc h2{margin:.7rem 0 0;font-size:1.1rem}
.doc h3{margin:.6rem 0 0;font-size:1rem}
.doc p,.doc ul,.doc ol,.doc blockquote{margin:0}
.doc ul,.doc ol{padding-left:1.3rem;display:grid;gap:.25rem}
.doc blockquote{padding-left:.9rem;border-left:3px solid var(--line2);color:var(--dim)}
.doc code{font:400 .86em var(--mono);background:var(--surface2);border-radius:4px;padding:.1rem .3rem}
.doc pre{margin:0;padding:.9rem 1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow-x:auto}
.doc pre code{background:none;padding:0}
.doc img{max-width:100%;height:auto}
.doc hr{width:100%;border:0;border-top:1px solid var(--line2)}
.doc table{border-collapse:collapse;font-size:.88rem;display:block;overflow-x:auto}
.doc th,.doc td{border:1px solid var(--line);padding:.35rem .6rem;text-align:left}
.doc th{background:var(--surface2);font-weight:600}
.src{margin:0;padding:1rem 1.1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;font:400 .82rem/1.65 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.tracks{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.trow{display:grid;grid-template-columns:2.4rem minmax(0,1fr) 5.5rem 5.5rem;gap:.4rem .7rem;align-items:center;padding:.6rem .9rem;border-bottom:1px solid var(--line)}
.tracks>:last-child{border-bottom:0}
.trow[aria-current]{background:var(--surface2)}
.trow .no{font:400 .78rem/1 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
.trow .nm{font:400 .86rem/1.35 var(--mono);overflow-wrap:anywhere}
.trow .sz{font:400 .76rem/1 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums;text-align:right}
.trow button{justify-self:end;font:600 .78rem/1 var(--sans);padding:.4rem .8rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface2);color:var(--ink);cursor:pointer}
.trow button[aria-disabled=true]{border-style:dashed;color:var(--faint);cursor:default}
.trow .tg{grid-column:2/-1;font:600 .62rem/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--dim)}
.trow .tg:empty{display:none}
.trow .why{grid-column:1/-1;margin:0;font-size:.82rem;color:var(--bad)}
.trow .why:empty{display:none}
.trow.gone .nm,.trow.gone .sz{color:var(--faint)}
.afoot{margin:.6rem 0 0;display:grid;gap:.3rem;padding-top:.8rem;border-top:1px solid var(--line);font:400 .74rem/1.5 var(--mono);color:var(--faint);overflow-wrap:anywhere}
.afoot p{margin:0}
.afoot a{font-weight:600}
.afoot a::after{content:" \\2197"}
.bar{position:fixed;inset:auto 0 0 0;display:flex;align-items:center;gap:.6rem;padding:.6rem 1.1rem;border-top:1px solid var(--line);background:var(--surface)}
.bar button{flex:none;font:600 .8rem/1 var(--sans);padding:.45rem .8rem;border:1px solid var(--line2);border-radius:6px;background:var(--surface2);color:var(--ink);cursor:pointer}
.bar button[disabled]{opacity:.45;cursor:default}
.bar .now{flex:none;min-width:0;max-width:14rem;margin:0;font:400 .78rem/1.3 var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar input[type=range]{flex:1;min-width:3rem;accent-color:var(--accent)}
.bar input[type=range]:disabled{opacity:.45}
.bar .at{flex:none;font:400 .76rem/1 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.player{padding-bottom:5rem}
@media (min-width:48rem){.wrap{padding-left:1.5rem;padding-right:1.5rem}}`;

interface Frame {
  title: string;
  badge: string;
  band: string;
  main: string;
  status: number;
  csp: string;
  column: string;
  pinned: string;
  referrer: string;
}

const page = (frame: Frame): Response =>
  htmlPage(
    frame.status,
    frame.title,
    STYLE,
    `<header class="abar"><p class="brand"><i></i>recall</p>${
      frame.badge === "" ? "" : `<span class="badge">${escapeHtml(frame.badge)}</span>`
    }</header>${frame.band}<main class="wrap${frame.column}">${frame.main}</main>${frame.pinned}`,
    {
      "content-security-policy": frame.csp,
      "cache-control": "private, no-cache",
      "referrer-policy": frame.referrer,
    },
  );

// A token never leaves in a header, so a page under a share prefix sends no referrer at all where
// recall's own pages send the origin.
const referrerFor = (audience: Audience): string => (audience.kind === "recipient" ? "no-referrer" : "same-origin");

const dashboardLink = (dashboard: string): string =>
  `<p><a href="${escapeHtml(dashboard)}" target="_blank" rel="noreferrer">The recall dashboard</a></p>`;

// Each of the footer's three parts — the name, both permissions and the dashboard — is forbidden on
// a shared page, so a recipient's page ends with the body rather than carrying a stripped footer.
// The audience carrying no dashboard address is what makes that structural.
const footer = (record: ArtifactRecord, audience: Audience): string => {
  if (audience.kind === "recipient") return "";
  return `<footer class="afoot"><p>${escapeHtml(
    `${record.name} · read ${record.read} · write ${record.write}`,
  )}</p>${dashboardLink(audience.dashboard)}</footer>`;
};

const entryOf = (record: ArtifactRecord): ArtifactFile => {
  const entry = record.files.find((file) => file.path === record.entryPath) ?? record.files[0];
  if (entry === undefined) throw new Error(`${record.name} names no file to serve`);
  return entry;
};

const moment = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ");

// A share's unit is the day, so an expiry is drawn as a date and never as a timestamp.
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

// One full-width block directly under the top bar, with one tenant: the owner's bar, a recipient's
// line, or nothing at all. It pushes the content column down by its own height and moves nothing
// sideways, and it is first in the document, so the owner's one control is the first tab stop.
const band = (audience: Audience): string => {
  if (audience.kind === "account") return "";
  if (audience.kind === "recipient") {
    return `<div class="band"><p>${escapeHtml(
      `This artifact was shared with you. The share stops working on ${day(audience.expiresAt)}.`,
    )}</p></div>`;
  }
  const { shares } = audience;
  const line =
    shares === 0
      ? "This artifact is shared with nobody."
      : `This artifact has ${shares} ${shares === 1 ? "share" : "shares"}.`;
  return `<div class="band"><p>${escapeHtml(line)}</p><a href="${escapeHtml(audience.sharesUrl)}" target="_blank" rel="noreferrer">${
    shares === 0 ? "Share it" : "Manage sharing"
  }</a></div>`;
};

const heading = (record: ArtifactRecord, meta: string): string =>
  `<h1>${escapeHtml(record.title)}</h1>${
    record.description === "" ? "" : `<p class="adesc">${escapeHtml(record.description)}</p>`
  }<p class="ameta">${escapeHtml(meta)}</p>`;

const views = (base: string, raw: boolean, renders: boolean): string => {
  const address = escapeHtml(base);
  const rendered = renders
    ? `<a href="${address}"${raw ? "" : ' aria-current="page"'}>Rendered</a>`
    : "<span>Rendered</span>";
  return `<p class="views">${rendered}<a href="${address}?view=${RAW_VIEW}"${
    raw ? ' aria-current="page"' : ""
  }>Raw</a></p>`;
};

// The last writer is an email address, so a shared page drops it and keeps the size and the publish
// time every page prints.
const metaLine = (audience: Audience, record: ArtifactRecord, head: string): string =>
  audience.kind === "recipient" ? head : `${head} · ${record.lastWriter}`;

const documentMeta = (record: ArtifactRecord, audience: Audience): string =>
  metaLine(audience, record, `${sizeText(entryOf(record).bytes)} · published ${moment(record.updatedAt)}`);

const EMPTY_WHY =
  "The markdown published under this name is empty. Republish it with recall publish --replace to fill it in, or read the raw view to see the file as it was published.";

// A recipient cannot republish, so the copy names the one person who can do anything about it.
const SHARED_EMPTY_WHY =
  "The markdown published under this name is empty. Read the raw view to see the file as it was published, or ask whoever sent you this address about it.";

// A document is recall's own HTML, rendered from the publisher's markdown, so it carries no script
// at all and reads with scripts off. A document holding no text says so and keeps both view
// controls, because the raw view's empty block is what proves the file was empty rather than the
// renderer broken.
export const documentPage = (record: ArtifactRecord, chrome: ArtifactChrome, rendered: string): Response => {
  const { audience } = chrome;
  const main =
    rendered.trim() === ""
      ? `<div class="empty"><b>${escapeHtml(`${record.name} holds no text.`)}</b><p>${escapeHtml(
          audience.kind === "recipient" ? SHARED_EMPTY_WHY : EMPTY_WHY,
        )}</p></div>`
      : `<div class="doc">${rendered}</div>`;
  return page({
    title: record.title,
    badge: record.type,
    band: band(audience),
    main: `${heading(record, documentMeta(record, audience))}${views(chrome.base, false, true)}${main}${footer(record, audience)}`,
    status: 200,
    csp: ARTIFACT_PAGE_CSP,
    column: "",
    pinned: "",
    referrer: referrerFor(audience),
  });
};

// The published bytes, escaped into one block. Over the render ceiling the rendered control is
// drawn inert and out of the tab order, so a reader who aims at it reads why rather than finding a
// dead link. `source` arrives already cut to what the page may hold, and `capped` says whether
// anything was left out: the file's own address serves the whole of it as text/markdown, so the
// notice points there rather than leaving a reader to guess the view is complete.
export const rawDocumentPage = (
  record: ArtifactRecord,
  chrome: ArtifactChrome,
  source: string,
  capped: boolean,
): Response => {
  const entry = entryOf(record);
  const { audience } = chrome;
  const { bytes } = entry;
  const over = bytes > RENDER_CEILING_BYTES;
  const address = `${chrome.base}/${FILE_SEGMENT}/${entry.path}`;
  const notice = over
    ? `<div class="notice"><b>${escapeHtml("This document is too long to render.")}</b><p>${escapeHtml(
        `recall renders a document of up to ${sizeText(RENDER_CEILING_BYTES)} and this one is ${sizeText(bytes)}, so its address answers the raw view. Split it into smaller files and republish to read it rendered.`,
      )}</p></div>`
    : "";
  const cut = capped
    ? `<div class="notice"><b>${escapeHtml("This view shows the start of the file.")}</b><p>${escapeHtml(
        `${entry.path} runs to ${sizeText(bytes)} and this page prints the first ${sizeText(RAW_INLINE_BYTES)} of it.`,
      )} <a href="${escapeHtml(address)}">${escapeHtml(address)}</a> ${escapeHtml("serves the whole file.")}</p></div>`
    : "";
  return page({
    title: record.title,
    badge: record.type,
    band: band(audience),
    main: `${heading(record, documentMeta(record, audience))}${views(chrome.base, true, !over)}${notice}${cut}<pre class="src">${escapeHtml(
      source,
    )}</pre>${footer(record, audience)}`,
    status: 200,
    csp: ARTIFACT_PAGE_CSP,
    column: "",
    pinned: "",
    referrer: referrerFor(audience),
  });
};

const GONE_TAG = "UNAVAILABLE";

const GONE_WHY = "Storage holds no file at this path, so this track cannot play. Republish the artifact to restore it.";

// A recipient cannot republish, so the row names the one person who can do anything about it.
const SHARED_GONE_WHY =
  "Storage holds no file at this path, so this track cannot play. Ask whoever sent you this address about it.";

// An entry the manifest names and storage does not hold keeps a focusable control carrying
// aria-disabled: a disabled control drops out of the tab order, which hides the broken track from
// a reader who never sees the row.
const trackRow = (file: ArtifactFile, index: number, gone: boolean, shared: boolean): string =>
  `<li class="trow${gone ? " gone" : ""}" id="tr${index}">
<span class="no">${String(index + 1).padStart(2, "0")}</span><span class="nm">${escapeHtml(file.path)}</span><span class="sz">${escapeHtml(sizeText(file.bytes))}</span><button type="button" data-track="${index}"${gone ? ' aria-disabled="true"' : ""}>Play</button>
<span class="tg" id="tg${index}">${gone ? GONE_TAG : ""}</span><p class="why" id="wy${index}">${gone ? escapeHtml(`${file.path}. ${shared ? SHARED_GONE_WHY : GONE_WHY}`) : ""}</p></li>`;

// Always drawn, at rest as well as playing: a bar that appeared on the first play would shift the
// track list down under the reader's cursor.
const TRANSPORT = `<div class="bar" role="group" aria-label="Transport">
<button type="button" id="pprev" disabled>Prev</button>
<button type="button" id="pplay">Play</button>
<button type="button" id="pnext" disabled>Next</button>
<p class="now" id="pnow" role="status" aria-live="polite">Nothing is playing.</p>
<input type="range" id="pseek" min="0" max="1000" value="0" step="1" aria-label="Position" disabled>
<span class="at" id="pat">--:-- / --:--</span></div>`;

// A `</script` anywhere in the manifest would close the element early; escaping the one character
// that can open it keeps the JSON valid and the element whole.
const planJson = (plan: PlayerPlan): string => JSON.stringify(plan).replaceAll("<", "\\u003c");

// The track bytes stream: one audio element whose src is the file's own address, so the browser
// issues its own range requests and a seek never waits for the whole file to arrive. The page
// carries the manifest and the state machine runs in the bundle.
export const playerPage = (record: ArtifactRecord, chrome: ArtifactChrome, missing: readonly string[]): Response => {
  const gone = new Set(missing);
  const { audience } = chrome;
  const meta = metaLine(
    audience,
    record,
    `${record.fileCount} ${record.fileCount === 1 ? "track" : "tracks"} · ${sizeText(record.bytes)} · published ${moment(record.updatedAt)}`,
  );
  const plan: PlayerPlan = {
    base: chrome.base,
    tracks: record.files.map((file) => ({ path: file.path, gone: gone.has(file.path) })),
  };
  const rows = record.files
    .map((file, index) => trackRow(file, index, gone.has(file.path), audience.kind === "recipient"))
    .join("");
  return page({
    title: record.title,
    badge: record.type,
    band: band(audience),
    main: `${heading(record, meta)}
<ol class="tracks" role="list">${rows}</ol>
<audio id="paudio" preload="metadata"></audio>
<noscript><p class="notice">The player needs a script to run. Each track's own address streams its bytes, so a file reads with scripts off.</p></noscript>
<script type="application/json" id="pplan">${planJson(plan)}</script>
<script src="${escapeHtml(`${chrome.base}/${PLAYER_SEGMENT}`)}" defer></script>${footer(record, audience)}`,
    status: 200,
    csp: ARTIFACT_PLAYER_CSP,
    column: " player",
    pinned: TRANSPORT,
    referrer: referrerFor(audience),
  });
};

export const playerScript = (): Response =>
  new Response(PLAYER_SCRIPT, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });

// Every refusal the artifact hostname answers itself. A missing name and a name this reader may
// not read are one answer, so the page cannot say which it was.
export type ArtifactRefusal =
  | { kind: "unauthorized"; reason: string; address: string }
  | { kind: "forbidden"; email: string }
  | { kind: "lost" }
  | { kind: "method" };

const NOTICES: Record<ArtifactRefusal["kind"], { status: number; title: string }> = {
  unauthorized: { status: 401, title: "Sign-in ended" },
  forbidden: { status: 403, title: "Not invited" },
  lost: { status: 404, title: "No such artifact" },
  method: { status: 405, title: "Not allowed" },
};

const refusalBody = (refusal: ArtifactRefusal): string => {
  if (refusal.kind === "unauthorized") {
    return `<div class="notice"><b>${escapeHtml("Your sign-in to this host has ended.")}</b><p>${escapeHtml(
      `Cloudflare Access rejected the sign-in: ${refusal.reason}. Reloading this address signs in again.`,
    )}</p></div><p class="views"><a href="${escapeHtml(refusal.address)}">Reload this page</a></p>`;
  }
  if (refusal.kind === "forbidden") {
    return `<div class="notice"><b>${escapeHtml(`${refusal.email} is not invited to this recall.`)}</b><p>${escapeHtml(
      "Ask the owner of this recall to add the email. Reloading answers the same, because the sign-in worked and the invitation is what is missing.",
    )}</p></div>`;
  }
  if (refusal.kind === "method") {
    return `<div class="notice"><b>${escapeHtml("This host only answers a GET.")}</b><p>${escapeHtml(
      "Every artifact page is a GET. Publishing and unpublishing run against the API, with recall publish and recall unpublish.",
    )}</p></div>`;
  }
  return `<div class="empty"><b>${escapeHtml("This recall publishes no artifact at this address.")}</b><p>${escapeHtml(
    "Check the name, or find the artifact in the dashboard.",
  )}</p></div>`;
};

// A reader at the 404 has passed Access already, so the dashboard is where they find the name they
// got wrong. A reader the sign-in or the invitation refused gains nothing from a link to a second
// host they are no better placed to reach, so those two carry the bar alone.
export const artifactNotice = (refusal: ArtifactRefusal, dashboard: string): Response => {
  const { status, title } = NOTICES[refusal.kind];
  const link = refusal.kind === "lost" ? `<footer class="afoot">${dashboardLink(dashboard)}</footer>` : "";
  return page({
    title,
    badge: "",
    band: "",
    main: `${refusalBody(refusal)}${link}`,
    status,
    csp: ARTIFACT_PAGE_CSP,
    column: "",
    pinned: "",
    referrer: "same-origin",
  });
};

const SHARE_NOTICES: Record<ShareRefusal["kind"], { status: number; title: string }> = {
  gone: { status: 404, title: "Share no longer available" },
  elsewhere: { status: 403, title: "Shared with another address" },
  method: { status: 405, title: "Not allowed" },
};

// Cloudflare's logout is host-wide: there is no prefix-scoped one, so the control ends every
// sign-in the reader holds to this hostname and the copy says so rather than promising less.
const LOGOUT_REACH = "Signing in again ends the sign-in to every page on this host.";

const shareRefusalBody = (refusal: ShareRefusal): string => {
  if (refusal.kind === "elsewhere") {
    return `<div class="notice"><b>${escapeHtml("This artifact was shared with another address.")}</b><p>${escapeHtml(
      "You proved a different one, so this share does not open for you. If you have a second address, sign in again and give the one the share was sent to.",
    )}</p></div><p class="views"><a href="${escapeHtml(refusal.signInAgain)}" autofocus>Sign in as another address</a></p>
<p class="ameta">${escapeHtml(LOGOUT_REACH)}</p>`;
  }
  if (refusal.kind === "method") {
    return `<div class="notice"><b>${escapeHtml("This address only answers a GET.")}</b><p>${escapeHtml(
      "A shared artifact is read and nothing else. Open the address in a browser to read it.",
    )}</p></div>`;
  }
  return `<div class="empty"><b>${escapeHtml("This share is no longer available.")}</b><p>${escapeHtml(
    "Ask whoever sent you this address for a new one.",
  )}</p></div>`;
};

// Everything recall answers a recipient with that is not a page. An unknown address, a changed
// token, a revoked share and an expired share are one answer, because a page that told them apart
// would tell an unknown holder that the artifact exists. None of the three names an artifact, an
// owner, an address or the dashboard: a recipient holds no account there.
export const shareNotice = (refusal: ShareRefusal): Response => {
  const { status, title } = SHARE_NOTICES[refusal.kind];
  return page({
    title,
    badge: "",
    band: "",
    main: shareRefusalBody(refusal),
    status,
    csp: ARTIFACT_PAGE_CSP,
    column: "",
    pinned: "",
    referrer: "no-referrer",
  });
};
