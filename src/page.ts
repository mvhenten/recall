export const CSRF_COOKIE = "__Host-recall_csrf";

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
code{font-size:1.6rem;letter-spacing:.15em}button,input{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}`;

const page = (status: number, title: string, body: string, headers: Record<string, string> = {}): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        ...headers,
      },
    },
  );

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
