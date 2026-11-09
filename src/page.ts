import { ARTIFACT_CONTENT_TYPE } from "./artifacts";

export const CSRF_COOKIE = "__Host-recall_csrf";

// The connector's consent form carries its own token under its own name. The `__Host-` prefix
// demands `Path=/`, so neither cookie can be scoped to the page that set it: one name for both
// forms would mean an open consent tab silently invalidating a device approval waiting in another,
// and the user would see a refused form with nothing to tell them why.
export const CONNECT_CSRF_COOKIE = "__Host-recall_connect";

// What a send that worked leaves behind, so the page it redirects to can say so once. The notice
// belongs to that one navigation and not to the address, which a reader bookmarks, reloads and
// walks back to; carrying it in the URL would reprint it every time.
export const SENT_COOKIE = "__Host-recall_sent";

export const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

// One palette for every page recall draws itself, on either hostname. Light and dark both come
// from prefers-color-scheme, so a page names a token and never a colour.
export const TOKENS = `:root{color-scheme:light dark;
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

const DEVICE_STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
code{font-size:1.6rem;letter-spacing:.15em}button,input{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}`;

const BASE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// What a page that runs script sends instead. The script is served by this Worker rather than
// written into the page, so the policy names the origin and no inline script runs at all; and the
// only host the page may fetch from is this one, which is where the transcript comes from.
export const SCRIPT_CSP = `${BASE_CSP}; script-src 'self'; connect-src 'self'`;

// recall's own pages on the artifact hostname. They are not the publisher's bytes, so they take
// none of the sandbox a site takes; they carry no form either, so nothing may be submitted from
// one at all. `img-src 'self'` is what a rendered document needs, and no wider: the renderer
// resolves a relative image into the artifact's own address, and an image a document points at
// another host with stays blocked, because a page here reaches no host but this one.
export const ARTIFACT_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

// The player, and nothing else on that hostname, runs a script and plays media. It connects
// nowhere: the audio element issues its own range requests against the file route.
export const ARTIFACT_PLAYER_CSP = `${ARTIFACT_PAGE_CSP}; script-src 'self'; media-src 'self'`;

// A size of a megabyte or more reads in MB to one decimal, on a dashboard row and on an artifact
// page alike, so the same artifact never prints two different sizes.
export const sizeText = (bytes: number): string => {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} kB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
};

// A page sets more than one cookie when it both holds a form token and clears a one-shot notice,
// and `set-cookie` is the one header that cannot be folded into a second value, so a list of
// values is appended rather than overwriting.
export const htmlPage = (
  status: number,
  title: string,
  style: string,
  body: string,
  headers: Record<string, string | string[]> = {},
): Response => {
  const built = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": BASE_CSP,
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
  });
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      built.set(name, value);
      continue;
    }
    for (const one of value) built.append(name, one);
  }
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}</body></html>`,
    { status, headers: built },
  );
};

// Every user's pages and files share this hostname, so each one loads into an opaque origin:
// inline style and script run, and a page reaches neither another host nor the storage, cookies
// and pages of whoever else publishes here.
export const ARTIFACT_CSP =
  "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; " +
  "form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

export const artifactPage = (body: ReadableStream): Response =>
  new Response(body, {
    headers: {
      "content-type": ARTIFACT_CONTENT_TYPE,
      "cache-control": "private, no-cache",
      "content-security-policy": ARTIFACT_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });

const page = (status: number, title: string, body: string, headers: Record<string, string> = {}): Response =>
  htmlPage(status, title, DEVICE_STYLE, `<h1>${escapeHtml(title)}</h1>${body}`, headers);

export const messagePage = (status: number, title: string, text: string): Response =>
  page(status, title, `<p>${escapeHtml(text)}</p>`);

export const enterCodePage = (email: string): Response =>
  page(
    200,
    "Sign in a device",
    `<p>Signed in as ${escapeHtml(email)}. Enter the code your terminal shows.</p>
<form method="get" action="/device"><input name="code" autocomplete="off" autofocus required><button type="submit">Continue</button></form>`,
  );

export const confirmPage = (email: string, userCode: string, deviceName: string, csrf: string): Response =>
  page(
    200,
    "Sign in a device",
    `<p>The device <strong>${escapeHtml(deviceName)}</strong> asks to use recall as ${escapeHtml(email)}.</p>
<p>Check that your terminal shows this code:</p><p><code>${escapeHtml(userCode)}</code></p>
<form method="post" action="/device">
<input type="hidden" name="user_code" value="${escapeHtml(userCode)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="deny">Deny</button>
</form>`,
    {
      "set-cookie": `${CSRF_COOKIE}=${csrf}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict`,
    },
  );

// What the connector's interactive sign-in ends on. Access has just proved the email; this is the
// one step that is the user's rather than Access's, so a client already holding an Access session
// still says yes before a token is minted for it.
//
// Approving answers a redirect to the client's own callback, and `form-action` is checked across a
// redirect, so the policy names that one origin beside this one. It is the origin of an address the
// client registered and no other.
export const grantPage = (
  email: string,
  clientName: string,
  callbackOrigin: string,
  requestId: string,
  csrf: string,
): Response =>
  page(
    200,
    "Connect recall",
    `<p><strong>${escapeHtml(clientName)}</strong> asks to read and write your recall memories as ${escapeHtml(email)}.</p>
<p>It reaches the memory tools and nothing else.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="request" value="${escapeHtml(requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit" name="action" value="approve">Connect</button><button type="submit" name="action" value="deny">Cancel</button>
</form>`,
    {
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
      "set-cookie": `${CONNECT_CSRF_COOKIE}=${csrf}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict`,
    },
  );

export const readCookie = (header: string | null, name: string): string | null => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};
