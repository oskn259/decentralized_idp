import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_SECONDS,
  MAX_ACCESS_TOKEN_LIFETIME_SECONDS,
  MAX_ASSERTION_LIFETIME_SECONDS,
  REFRESH_TOKEN_LIFETIME_SECONDS,
  checkFreshness,
  checkLifetime,
  verifyAssertion,
  verifyRefreshToken,
} from "../src/domain/service/credential.js";
import { DEFAULT_KEY_ID, NodeIdentity } from "../src/domain/value/node-identity.js";
import { assembleJwt, createSigningInput, Jwt } from "@decentralized-idp/sdk/jwt";
import {
  ACCESS_TOKEN_TYP,
  ASSERTION_TYP,
  AccessTokenClaims,
  CredentialClaims,
  REFRESH_TOKEN_TYP,
  accessTokenJwt,
  assertionJwt,
  refreshTokenJwt,
} from "@decentralized-idp/sdk/tokens";

function testIdentity(overrides: Partial<NodeIdentity> = {}): { identity: NodeIdentity; privateKey: Uint8Array } {
  const privateKey = ed25519.utils.randomPrivateKey();
  const groupPublicKey = ed25519.getPublicKey(privateKey);
  return {
    identity: {
      nodeId: 1,
      secretKeyShare: 0n,
      groupPublicKey,
      issuer: "http://localhost:3000",
      keyId: DEFAULT_KEY_ID,
      ...overrides,
    },
    privateKey,
  };
}

/** Signs a JWT with a plain Ed25519 key, standing in for the FROST-aggregated group signature. */
function sign(jwt: Jwt, privateKey: Uint8Array): string {
  const { signingInput, headerB64, payloadB64 } = createSigningInput(jwt);
  return assembleJwt(headerB64, payloadB64, ed25519.sign(signingInput, privateKey));
}

describe("checkLifetime", () => {
  it("accepts a lifetime from 1 second up to the maximum", () => {
    expect(() => checkLifetime("x", 0, 1, 30)).not.toThrow();
    expect(() => checkLifetime("x", 0, 30, 30)).not.toThrow();
  });

  it("rejects zero, negative and over-long lifetimes", () => {
    expect(() => checkLifetime("Assertion", 0, 0, 30)).toThrowError(/Assertion lifetime 0s out of range: exp - iat must be 1\.\.30/);
    expect(() => checkLifetime("Assertion", 10, 5, 30)).toThrowError(/lifetime -5s out of range/);
    expect(() => checkLifetime("Assertion", 0, 31, 30)).toThrowError(/lifetime 31s out of range/);
  });
});

describe("checkFreshness", () => {
  it("accepts iat within the clock skew window, inclusive", () => {
    expect(() => checkFreshness("x", 1000, 1000 + CLOCK_SKEW_SECONDS)).not.toThrow();
    expect(() => checkFreshness("x", 1000, 1000 - CLOCK_SKEW_SECONDS)).not.toThrow();
  });

  it("rejects iat one second outside the window, in either direction", () => {
    expect(() => checkFreshness("Assertion", 1000, 1000 + CLOCK_SKEW_SECONDS + 1)).toThrowError(
      /Assertion iat is outside the ±60s window/
    );
    expect(() => checkFreshness("Assertion", 1000, 1000 - CLOCK_SKEW_SECONDS - 1)).toThrowError(/outside the ±60s window/);
  });
});

describe("building the three JWTs", () => {
  it("builds the assertion with sub from the record, not the request", () => {
    const { identity } = testIdentity();
    const jwt = assertionJwt(identity, "usr_alice", {
      clientId: "client",
      scope: "openid",
      cnfJkt: "jkt",
      nonce: "n",
      iat: 100,
      exp: 130,
    });
    expect(jwt.header).toEqual({ alg: "EdDSA", typ: ASSERTION_TYP, kid: identity.keyId });
    expect(jwt.payload).toEqual({
      iss: identity.issuer,
      sub: "usr_alice",
      aud: identity.issuer,
      client_id: "client",
      scope: "openid",
      cnf: { jkt: "jkt" },
      nonce: "n",
      iat: 100,
      exp: 130,
    });
  });

  it("builds the access token from the verified credential plus the pinned claims", () => {
    const { identity } = testIdentity();
    const credential: CredentialClaims = {
      sub: "usr_alice",
      client_id: "client",
      scope: "openid",
      cnf: { jkt: "jkt" },
    };
    const claims: AccessTokenClaims = { iat: 200, exp: 3800, jti: "jti-1" };
    const jwt = accessTokenJwt(identity, credential, claims);
    expect(jwt.header.typ).toBe(ACCESS_TOKEN_TYP);
    expect(jwt.payload).toEqual({
      iss: identity.issuer,
      sub: "usr_alice",
      aud: "client",
      scope: "openid",
      cnf: { jkt: "jkt" },
      iat: 200,
      exp: 3800,
      jti: "jti-1",
    });
  });

  it("builds the refresh token without an aud or jti", () => {
    const { identity } = testIdentity();
    const credential: CredentialClaims = {
      sub: "usr_alice",
      client_id: "client",
      scope: "openid",
      cnf: { jkt: "jkt" },
    };
    const jwt = refreshTokenJwt(identity, credential, 200, 200 + REFRESH_TOKEN_LIFETIME_SECONDS);
    expect(jwt.header.typ).toBe(REFRESH_TOKEN_TYP);
    expect(jwt.payload).toEqual({
      iss: identity.issuer,
      sub: "usr_alice",
      cnf: { jkt: "jkt" },
      client_id: "client",
      scope: "openid",
      iat: 200,
      exp: 200 + REFRESH_TOKEN_LIFETIME_SECONDS,
    });
    expect(jwt.payload).not.toHaveProperty("aud");
    expect(jwt.payload).not.toHaveProperty("jti");
  });
});

describe("verifyAssertion", () => {
  function issuedAssertion(overrides: Partial<Record<string, unknown>> = {}, identity?: NodeIdentity, privateKey?: Uint8Array) {
    const built = identity && privateKey ? { identity, privateKey } : testIdentity();
    const now = 1_700_000_000;
    const jwt: Jwt = {
      header: { alg: "EdDSA", typ: ASSERTION_TYP, kid: built.identity.keyId },
      payload: {
        iss: built.identity.issuer,
        sub: "usr_alice",
        aud: built.identity.issuer,
        client_id: "client",
        scope: "openid",
        cnf: { jkt: "jkt" },
        iat: now,
        exp: now + 30,
        ...overrides,
      },
    };
    return { token: sign(jwt, built.privateKey), identity: built.identity, now };
  }

  it("accepts a well-formed, freshly issued assertion", () => {
    const { token, identity, now } = issuedAssertion();
    const claims = verifyAssertion(token, identity, now);
    expect(claims.sub).toBe("usr_alice");
    expect(claims.aud).toBe(identity.issuer);
    expect(claims.cnf.jkt).toBe("jkt");
  });

  it("rejects a missing iss, sub, client_id or cnf.jkt", () => {
    const { identity, privateKey } = testIdentity();
    const now = 1_700_000_000;
    const base = { iss: identity.issuer, sub: "usr_alice", client_id: "c", cnf: { jkt: "j" }, iat: now, exp: now + 30 };

    for (const [omit, expected] of [
      // iss is checked directly against the node's own issuer, not via credentialClaimsOf,
      // so an absent iss reports as a mismatch rather than "is missing".
      ["iss", /iss mismatch, expected/],
      ["sub", /sub is missing/],
      ["client_id", /client_id is missing/],
    ] as const) {
      const payload: Record<string, unknown> = { ...base };
      delete payload[omit];
      const token = sign({ header: { alg: "EdDSA", typ: ASSERTION_TYP, kid: identity.keyId }, payload }, privateKey);
      expect(() => verifyAssertion(token, identity, now), omit).toThrowError(expected);
    }

    const tokenNoJkt = sign(
      { header: { alg: "EdDSA", typ: ASSERTION_TYP, kid: identity.keyId }, payload: { ...base, cnf: {} } },
      privateKey
    );
    expect(() => verifyAssertion(tokenNoJkt, identity, now)).toThrowError(/cnf\.jkt is missing/);
  });

  it("rejects a token that is not exactly three dot-separated parts", () => {
    const { identity } = testIdentity();
    expect(() => verifyAssertion("a.b", identity, 0)).toThrowError(/rejected assertion: Malformed JWT: expected 3 parts/);
    expect(() => verifyAssertion("a.b.c.d", identity, 0)).toThrowError(/Malformed JWT: expected 3 parts/);
  });

  it("rejects an alg other than EdDSA", () => {
    const { identity, privateKey } = testIdentity();
    const now = 1_700_000_000;
    const jwt: Jwt = {
      header: { alg: "HS256", typ: ASSERTION_TYP, kid: identity.keyId },
      payload: { iss: identity.issuer, sub: "s", aud: identity.issuer, client_id: "c", cnf: { jkt: "j" }, iat: now, exp: now + 30 },
    };
    const token = sign(jwt, privateKey);
    expect(() => verifyAssertion(token, identity, now)).toThrowError(/Unsupported alg: HS256/);
  });

  it("rejects a header or payload segment that parses as JSON but is not a plain object", () => {
    const { identity } = testIdentity();
    const arraySegment = Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
    const objectSegment = Buffer.from(JSON.stringify({ alg: "EdDSA" }), "utf8").toString("base64url");
    expect(() => verifyAssertion(`${arraySegment}.${objectSegment}.sig`, identity, 0)).toThrowError(
      /segment is not a JSON object/
    );
  });

  it("rejects a payload missing iat or exp entirely", () => {
    const { identity, privateKey } = testIdentity();
    const now = 1_700_000_000;
    const payload = { iss: identity.issuer, sub: "s", aud: identity.issuer, client_id: "c", cnf: { jkt: "j" }, exp: now + 30 };
    const token = sign({ header: { alg: "EdDSA", typ: ASSERTION_TYP, kid: identity.keyId }, payload }, privateKey);
    expect(() => verifyAssertion(token, identity, now)).toThrowError(/rejected assertion: iat or exp is missing/);
  });

  it("rejects a foreign iss even with a valid signature", () => {
    const { identity, privateKey } = testIdentity();
    const now = 1_700_000_000;
    const jwt: Jwt = {
      header: { alg: "EdDSA", typ: ASSERTION_TYP, kid: identity.keyId },
      payload: {
        iss: "http://not-us.example",
        sub: "usr_alice",
        aud: identity.issuer,
        client_id: "c",
        cnf: { jkt: "j" },
        iat: now,
        exp: now + 30,
      },
    };
    const token = sign(jwt, privateKey);
    expect(() => verifyAssertion(token, identity, now)).toThrowError(/iss mismatch/);
  });
});

describe("verifyRefreshToken", () => {
  function issuedRefreshToken(overrides: Partial<Record<string, unknown>> = {}) {
    const { identity, privateKey } = testIdentity();
    const now = 1_700_000_000;
    const jwt: Jwt = {
      header: { alg: "EdDSA", typ: REFRESH_TOKEN_TYP, kid: identity.keyId },
      payload: {
        iss: identity.issuer,
        sub: "usr_alice",
        client_id: "client",
        scope: "openid",
        cnf: { jkt: "jkt" },
        iat: now,
        exp: now + REFRESH_TOKEN_LIFETIME_SECONDS,
        ...overrides,
      },
    };
    return { token: sign(jwt, privateKey), identity, now };
  }

  it("accepts a well-formed refresh token and allows an absent aud", () => {
    const { token, identity, now } = issuedRefreshToken();
    const claims = verifyRefreshToken(token, identity, now);
    expect(claims.sub).toBe("usr_alice");
    expect(claims.aud).toBeUndefined();
  });

});

describe("lifetime and freshness constants agree with the protocol", () => {
  it("caps at the documented values", () => {
    expect(MAX_ASSERTION_LIFETIME_SECONDS).toBe(30);
    expect(MAX_ACCESS_TOKEN_LIFETIME_SECONDS).toBe(3600);
    expect(REFRESH_TOKEN_LIFETIME_SECONDS).toBe(86400 * 30);
    expect(CLOCK_SKEW_SECONDS).toBe(60);
  });
});
