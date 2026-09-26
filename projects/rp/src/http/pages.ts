import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { JWTPayload } from "jose";

/** Every page of the shop. No OAuth here: the routes hand these the claims to show. */

/** The authorization server's refusal, as OAuth reports it. */
export function errorPage(error: string, description: string | undefined) {
  return page(html`<p class="notice">${error}: ${description ?? ""}</p>`);
}

/** Renders a claim's Unix-seconds timestamp as an ISO 8601 UTC string, with the raw seconds kept alongside for comparison. */
function formatTime(seconds: unknown) {
  const iso = new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return html`${iso} <span class="raw">${String(seconds)}</span>`;
}

/** The signed-in page: the access token's claims in the shop's card, and the Refresh form in a panel of DAuth's own look. */
export function claimsPage(claims: JWTPayload, sessionId: string) {
  return page(html`<section class="card">
      <h2>You are signed in</h2>
      <p class="lede">The gateway issued an access token bound to this browser session. These are its claims.</p>
      <table class="claims">
        <tr><th>sub</th><td>${String(claims.sub)}</td></tr>
        <tr><th>scope</th><td>${String(claims.scope)}</td></tr>
        <tr><th>jti</th><td>${String(claims.jti)}</td></tr>
        <tr><th>iat</th><td>${formatTime(claims.iat)}</td></tr>
        <tr><th>exp</th><td>${formatTime(claims.exp)}</td></tr>
      </table>
    </section>
    <section class="dauth">
      <div class="ring">${RING}</div>
      <div class="dauth-body">
        <p class="wordmark">DAuth</p>
        <p>Your session is a DAuth token. Refreshing asks the identity nodes for new signature shares; DAuth puts them together.</p>
        <ol>
          <li>Asking the gateway to refresh</li>
          <li>The nodes signed new shares</li>
          <li>A new token, put together by DAuth</li>
        </ol>
        <form method="post" action="/refresh"><input type="hidden" name="session" value="${sessionId}" /><button>Refresh</button></form>
      </div>
    </section>
    <script>
      // Plays the ring's assembly, one arc and one line every 650 ms, then submits for real.
      const form = document.querySelector(".dauth form");
      form.addEventListener("submit", (event) => {
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        event.preventDefault();
        form.querySelector("button").disabled = true;
        const arcs = document.querySelectorAll(".dauth .arc");
        const lines = document.querySelectorAll(".dauth li");
        const dot = document.querySelector(".dauth .dot");
        arcs.forEach((arc) => arc.classList.add("out"));
        dot.classList.add("out");
        arcs.forEach((arc, i) => setTimeout(() => { arc.classList.replace("out", "in"); lines[i].classList.add("done"); }, 650 * (i + 1)));
        setTimeout(() => dot.classList.replace("out", "in"), 650 * 4);
        setTimeout(() => form.submit(), 650 * 4 + 500);
      });
    </script>`);
}

/** The shop front: a third-party service that leaves sign-in to DAuth. */
export function homePage() {
  return page(html`<section class="hero">
      <h2>Everything your cat would order, if cats had a login.</h2>
      <p class="lede">Matatabi Shop keeps no passwords. Signing in goes through DAuth, and the shop only ever sees an access token.</p>
      <a class="button" href="/login">${MARK} Sign in with DAuth</a>
    </section>
    <section class="products">
      <article><div class="swatch s1"></div><h3>Silvervine sticks</h3><p>¥680</p></article>
      <article><div class="swatch s2"></div><h3>Sunbeam bed</h3><p>¥4,200</p></article>
      <article><div class="swatch s3"></div><h3>Cardboard castle</h3><p>¥2,900</p></article>
    </section>`);
}

/** DAuth's mark, so the sign-in button shows where the browser is about to go. */
const MARK = html`<svg viewBox="0 0 100 100" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"><path d="M55.90 16.52 A34 34 0 0 1 81.95 61.63"/><path d="M76.04 71.85 A34 34 0 0 1 23.96 71.85"/><path d="M18.05 61.63 A34 34 0 0 1 44.10 16.52" opacity="0.86"/><circle cx="50" cy="50" r="7" fill="currentColor" stroke="none"/></svg>`;

/** The same mark with its parts classed, so the refresh panel can assemble it. */
const RING = html`<svg viewBox="0 0 100 100" role="img" aria-label="DAuth" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"><path class="arc" d="M55.90 16.52 A34 34 0 0 1 81.95 61.63"/><path class="arc" d="M76.04 71.85 A34 34 0 0 1 23.96 71.85"/><path class="arc" d="M18.05 61.63 A34 34 0 0 1 44.10 16.52" opacity="0.86"/><circle class="dot" cx="50" cy="50" r="7" fill="currentColor" stroke="none"/></svg>`;

/** One layout for every page: the shop's own colours and typeface, unlike the gateway's. */
function page(body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Matatabi Shop</title>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@600;800&display=swap" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap" />
        <style>
          :root { --cream: #fff6e9; --card: #ffffff; --plum: #3a2630; --coral: #e85d3b; --mustard: #f2b441; --mint: #7fc8a9; --sky: #8fb8e8; }
          body { margin: 0; font-family: "Nunito", system-ui, sans-serif; background: var(--cream); color: var(--plum); }
          header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 24px; background: var(--coral); color: #fff; }
          header .brand { font-weight: 800; font-size: 1.3rem; letter-spacing: 0.01em; }
          header a { color: inherit; font-weight: 600; text-decoration: none; }
          main { max-width: 56rem; margin: 0 auto; padding: 40px 16px 64px; display: grid; gap: 32px; }
          h2 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.4rem); line-height: 1.15; text-wrap: balance; }
          .lede { margin: 12px 0 20px; max-width: 42ch; line-height: 1.6; }
          .button { display: inline-flex; align-items: center; gap: 10px; padding: 12px 20px; border: 0; border-radius: 999px; background: var(--plum); color: var(--cream); font: inherit; font-weight: 800; text-decoration: none; cursor: pointer; }
          .button svg { width: 22px; height: 22px; }
          .products { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; }
          .products article { background: var(--card); border-radius: 16px; padding: 14px; box-shadow: 0 2px 0 rgba(58, 38, 48, 0.08); }
          .products h3 { margin: 12px 0 4px; font-size: 1rem; }
          .products p { margin: 0; font-weight: 800; color: var(--coral); }
          .swatch { aspect-ratio: 4 / 3; border-radius: 12px; }
          .s1 { background: var(--mustard); } .s2 { background: var(--sky); } .s3 { background: var(--mint); }
          .card { background: var(--card); border-radius: 16px; padding: 24px; box-shadow: 0 2px 0 rgba(58, 38, 48, 0.08); display: grid; gap: 12px; justify-items: start; }
          .claims { border-collapse: collapse; width: 100%; }
          .claims th { text-align: left; padding: 8px 12px 8px 0; color: var(--coral); font-weight: 800; width: 6rem; }
          .claims td { padding: 8px 0; word-break: break-all; }
          .raw { color: rgba(58, 38, 48, 0.55); font-size: .85em; margin-left: .5em; }
          .dauth { --paper: #f6f7f9; --ink: #1a1e24; --muted: #5b6470; --line: #d7dbe2; display: flex; gap: 20px; align-items: flex-start; padding: 20px; background: var(--paper); color: var(--ink); border: 1px solid var(--line); border-radius: 12px; font-family: "IBM Plex Sans", system-ui, sans-serif; font-size: 0.95rem; line-height: 1.5; }
          .dauth .ring { flex: none; width: 4.5rem; height: 4.5rem; margin: 6px 8px; }
          .dauth svg { overflow: visible; }
          .dauth-body { display: grid; gap: 10px; justify-items: start; }
          .dauth p { margin: 0; max-width: 52ch; }
          .dauth .wordmark { font-weight: 600; font-size: 1.1rem; letter-spacing: 0.01em; }
          .dauth ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; font-size: 0.9rem; color: var(--muted); }
          .dauth li { position: relative; padding-left: 1.2rem; transition: color 0.45s ease; }
          .dauth li::before { content: ""; position: absolute; left: 0; top: 0.45em; width: 0.5rem; height: 0.5rem; border-radius: 50%; border: 1.5px solid var(--line); box-sizing: border-box; }
          .dauth li.done { color: var(--ink); }
          .dauth li.done::before { background: var(--ink); border-color: var(--ink); }
          .dauth form { margin-top: 4px; }
          .dauth button { padding: 0.6rem 1.1rem; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: var(--ink); color: var(--paper); cursor: pointer; }
          .dauth button:disabled { opacity: 0.4; cursor: default; }
          .dauth button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
          .arc, .dot { transform-box: view-box; transform-origin: 50px 50px; }
          .arc.out { opacity: 0.12; transform: scale(1.45); }
          .arc.in { transform: scale(1); transition: transform 0.55s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.55s ease; }
          .dot.out { opacity: 0; transform: scale(0); }
          .dot.in { opacity: 1; transform: scale(1); transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.3s ease; }
          @media (max-width: 480px) { .dauth { flex-direction: column; } }
          .notice { background: var(--card); border-left: 6px solid var(--mustard); border-radius: 12px; padding: 16px 20px; }
        </style>
      </head>
      <body>
        <header><a class="brand" href="/">Matatabi Shop</a><a href="/login">Sign in</a></header>
        <main>${body}</main>
      </body>
    </html>`;
}
