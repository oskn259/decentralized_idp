import { useState } from "react";
import { register } from "./client/register.js";
import { signOn } from "./client/sign-on.js";

/** What `/authorize` puts in this page's URL. */
interface AuthorizeParams {
  /** The challenge, signed in as the assertion's nonce. */
  challenge: string | null;
  redirectUri: string | null;
  /** The relying party's DPoP thumbprint the assertion binds to. */
  dpopJkt: string | null;
  clientId: string;
  scope: string;
  state: string;
}

function readAuthorizeParams(search: string): AuthorizeParams {
  const params = new URLSearchParams(search);
  return {
    challenge: params.get("c"),
    redirectUri: params.get("redirect_uri"),
    dpopJkt: params.get("dpop_jkt"),
    clientId: params.get("client_id") ?? "",
    scope: params.get("scope") ?? "",
    state: params.get("state") ?? "",
  };
}

/**
 * The gateway serves this page, so its API is on the same origin and its origin is the issuer.
 * Called only once `ready`, which is why the `!` assertions hold.
 */
function signOnFromThisPage(authorize: AuthorizeParams, username: string, password: string, log: (line: string) => void): Promise<string> {
  return signOn({
    gatewayUrl: "",
    issuer: window.location.origin,
    username,
    password,
    clientId: authorize.clientId,
    scope: authorize.scope,
    cnfJkt: authorize.dpopJkt!,
    nonce: authorize.challenge!,
    log,
  });
}

/** Registers the account, then signs on with the same credentials (the whitepaper's flow: registration continues straight into login). */
async function registerThenSignOn(authorize: AuthorizeParams, username: string, password: string, log: (line: string) => void): Promise<string> {
  await register({ gatewayUrl: "", username, password, log });
  return signOnFromThisPage(authorize, username, password, log);
}

/**
 * `redirect_uri?code=<assertion>&state=<state>`: the assertion goes back as the authorization code.
 * Called only after a sign-on, which needs `ready`, so `redirect_uri` is present.
 */
function callbackUrl(authorize: AuthorizeParams, assertion: string): string {
  const url = new URL(authorize.redirectUri!);
  url.searchParams.set("code", assertion);
  url.searchParams.set("state", authorize.state);
  return url.toString();
}

/**
 * The login page. `/authorize` sends the browser here with everything the assertion needs
 * in the URL; the page turns the password into the assertion in this tab and hands it back
 * to the relying party as the authorization code.
 */
export default function App() {
  const authorize = readAuthorizeParams(window.location.search);
  const ready = Boolean(authorize.challenge && authorize.redirectUri && authorize.dpopJkt);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [assertion, setAssertion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setLines([]);
    setError(null);
    setAssertion(null);
    try {
      const log = (line: string) => setLines((prev) => [...prev, line]);
      const result = creatingAccount
        ? await registerThenSignOn(authorize, username, password, log)
        : await signOnFromThisPage(authorize, username, password, log);
      setAssertion(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const action = creatingAccount ? "Create account and sign on" : "Sign on";
  const clientLine = authorize.clientId ? <>Client <code>{authorize.clientId}</code> asks for <code>{authorize.scope || "(no scope)"}</code>.</> : "No client.";

  return (
    <main>
      <h1>Sign in</h1>
      <p className="muted">
        {clientLine}{" "}
        The password is blinded in this tab; the identity nodes never see it.
      </p>

      {!ready && <p className="error">Missing <code>c</code>, <code>redirect_uri</code> or <code>dpop_jkt</code>: start from the relying party.</p>}

      <form onSubmit={submit}>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <label>
          <input type="checkbox" checked={creatingAccount} onChange={(e) => setCreatingAccount(e.target.checked)} />
          Create account
        </label>
        <button type="submit" disabled={!ready || busy || !password}>
          {busy ? "Working…" : action}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {lines.length > 0 && (
        <pre className="trace">{lines.join("\n")}</pre>
      )}

      {assertion && (
        <section>
          <h2>Assertion (authorization code)</h2>
          <pre className="token">{assertion}</pre>
          <button onClick={() => (window.location.href = callbackUrl(authorize, assertion))}>Return to the relying party</button>
        </section>
      )}
    </main>
  );
}
