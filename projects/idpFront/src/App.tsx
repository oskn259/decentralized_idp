import { useState } from "react";
import Mark from "./Mark.js";
import { register } from "./client/register.js";
import { SignOnProgress, signOn } from "./client/sign-on.js";

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
function signOnFromThisPage(authorize: AuthorizeParams, username: string, password: string, log: (line: string) => void, progress: SignOnProgress): Promise<string> {
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
    progress,
  });
}

/** Registers the account, then signs on with the same credentials (the whitepaper's flow: registration continues straight into login). */
async function registerThenSignOn(authorize: AuthorizeParams, username: string, password: string, log: (line: string) => void, progress: SignOnProgress): Promise<string> {
  await register({ gatewayUrl: "", username, password, log });
  return signOnFromThisPage(authorize, username, password, log, progress);
}

/** What the card shows: the three steps, and which shares have settled into the ring. */
interface Story {
  active: boolean;
  sent: boolean;
  shares: number[];
  settled: number[];
  assembled: boolean;
}

const NO_STORY: Story = { active: false, sent: false, shares: [], settled: [], assembled: false };

/** Milliseconds between the beats of the assembly. Slow on purpose: the point is to see the pieces come together. */
const BEAT = 650;

/**
 * The real sign-on takes a few hundred milliseconds; this replays what happened at a pace
 * the eye can follow. `progress` records the facts as they come, and `play` shows them.
 */
function storyTeller(setStory: (update: (s: Story) => Story) => void): { progress: SignOnProgress; play(): Promise<void> } {
  let shares: number[] = [];
  let decrypted: number[] = [];
  const beat = (update: (s: Story) => Story) =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        setStory(update);
        resolve();
      }, BEAT)
    );
  return {
    progress: {
      sent: () => setStory((s) => ({ ...s, active: true, sent: true })),
      sharesReceived: (nodeIds) => (shares = nodeIds),
      decrypted: (nodeId) => (decrypted = [...decrypted, nodeId]),
      assembled: () => {},
    },
    async play() {
      await beat((s) => ({ ...s, shares }));
      for (const nodeId of decrypted) await beat((s) => ({ ...s, settled: [...s.settled, nodeId] }));
      await beat((s) => ({ ...s, assembled: true }));
      await beat((s) => s);
    },
  };
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
  const [story, setStory] = useState<Story>(NO_STORY);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setLines([]);
    setError(null);
    setAssertion(null);
    setStory(NO_STORY);
    const teller = storyTeller(setStory);
    try {
      const log = (line: string) => setLines((prev) => [...prev, line]);
      const result = creatingAccount
        ? await registerThenSignOn(authorize, username, password, log, teller.progress)
        : await signOnFromThisPage(authorize, username, password, log, teller.progress);
      await teller.play();
      setAssertion(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const action = creatingAccount ? "Create account and sign on" : "Sign on";
  return (
    <main>
      <div className="brand"><Mark />DAuth</div>

      <p className="request">
        {authorize.clientId ? <><code>{authorize.clientId}</code> asks you to sign in{authorize.scope ? <> and share <code>{authorize.scope}</code></> : null}.</> : "No client asked for a sign-in."}
      </p>

      {!ready && <p className="error">Missing <code>c</code>, <code>redirect_uri</code> or <code>dpop_jkt</code>: start from the relying party.</p>}

      {!assertion && (
      <form onSubmit={submit}>
        <label>
          Username
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <label className="check">
          <input type="checkbox" checked={creatingAccount} onChange={(e) => setCreatingAccount(e.target.checked)} />
          Create account
        </label>
        <button type="submit" disabled={!ready || busy || !password}>
          {busy ? "Working…" : action}
        </button>
        <p className="assurance">Your password stays in this page. Each identity node holds one share of the signature; DAuth's gateway only relays. The signature is put together here, from at least two shares.</p>
      </form>
      )}

      {story.active && (
        <section className="story">
          <div className="ring"><Mark live filled={story.settled} assembled={story.assembled} /></div>
          <ol>
            <li className={story.sent ? "done" : ""}>Your password was blinded in this page and sent to the gateway.</li>
            <li className={story.shares.length > 0 ? "done" : ""}>
              {story.shares.length > 0 ? `The gateway relayed it to ${story.shares.length} nodes; each answered with an encrypted share.` : "The gateway relays it to the nodes…"}
            </li>
            <li className={story.assembled ? "done" : ""}>
              {story.assembled
                ? `This browser decrypted ${story.settled.length} shares and put the signature back together. No node and no gateway saw your password.`
                : error
                  ? "The shares did not decrypt here. Nothing about your password left this page."
                  : `This browser decrypts the shares and puts the signature back together… ${story.settled.length} of ${story.shares.length || 3}`}
            </li>
          </ol>
        </section>
      )}

      {error && <p className="error">{error}</p>}

      {assertion && (
        <section className="result">
          <h2>Signed on</h2>
          <pre className="token">{assertion}</pre>
          <button onClick={() => (window.location.href = callbackUrl(authorize, assertion))}>Return to the relying party</button>
        </section>
      )}

      {lines.length > 0 && (
        <details>
          <summary>What happened in this page</summary>
          <pre className="trace">{lines.join("\n")}</pre>
        </details>
      )}
    </main>
  );
}
