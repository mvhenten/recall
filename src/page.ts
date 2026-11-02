import { ARTIFACT_CONTENT_TYPE } from "./artifacts";

export const CSRF_COOKIE = "__Host-recall_csrf";

export const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const DEVICE_STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
code{font-size:1.6rem;letter-spacing:.15em}button,input{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}`;

export const htmlPage = (
  status: number,
  title: string,
  style: string,
  body: string,
  headers: Record<string, string> = {},
): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "x-frame-options": "DENY",
        "referrer-policy": "same-origin",
        ...headers,
      },
    },
  );

// A published page carries everything it draws, so its own inline style, script and data: assets
// run while nothing may reach another host. It answers on its own hostname alone, never on the one
// that holds the dashboard and the API.
const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; media-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

// Every read goes through the Worker and nothing caches at the edge, so a republished page is the
// one the next reload draws.
export const artifactPage = (body: ReadableStream, contentType = ARTIFACT_CONTENT_TYPE): Response =>
  new Response(body, {
    headers: {
      "content-type": contentType,
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

export const readCookie = (header: string | null, name: string): string | null => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};
