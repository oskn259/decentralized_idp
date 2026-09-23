import { describe, expect, it } from "vitest";
import { assembleJwt, createSigningInput, decodeJwt, deterministicJsonStringify } from "../src/jwt.js";
import {
  ACCESS_TOKEN_TYP,
  ASSERTION_TYP,
  REFRESH_TOKEN_TYP,
  accessTokenJwt,
  assertionJwt,
  credentialClaimsOf,
  refreshTokenJwt,
  type AccessTokenClaims,
  type AssertionRequest,
  type CredentialClaims,
  type TokenIssuer,
} from "../src/tokens.js";

const issuer: TokenIssuer = { issuer: "https://issuer.example", keyId: "key-1" };

const credential: CredentialClaims = {
  sub: "user-1",
  client_id: "client-1",
  scope: "openid profile",
  cnf: { jkt: "thumbprint-1" },
};

describe("assertionJwt", () => {
  const request: AssertionRequest = {
    clientId: "client-1",
    scope: "openid profile",
    cnfJkt: "thumbprint-1",
    nonce: "nonce-1",
    iat: 1000,
    exp: 2000,
  };

  it("builds the documented header and payload", () => {
    const jwt = assertionJwt(issuer, "user-1", request);
    expect(jwt.header).toEqual({ alg: "EdDSA", typ: ASSERTION_TYP, kid: "key-1" });
    expect(jwt.payload).toEqual({
      iss: "https://issuer.example",
      sub: "user-1",
      aud: "https://issuer.example",
      client_id: "client-1",
      scope: "openid profile",
      cnf: { jkt: "thumbprint-1" },
      nonce: "nonce-1",
      iat: 1000,
      exp: 2000,
    });
  });

  it("omits nonce from the serialized signing input when not given", () => {
    const withNonce = assertionJwt(issuer, "user-1", request);
    const withoutNonce = assertionJwt(issuer, "user-1", { ...request, nonce: undefined });

    const { payloadB64: withNoncePayload } = createSigningInput(withNonce);
    const { payloadB64: withoutNoncePayload } = createSigningInput(withoutNonce);

    expect(deterministicJsonStringify(withNonce.payload)).toContain("nonce");
    expect(withoutNoncePayload).not.toEqual(withNoncePayload);
    expect(deterministicJsonStringify(withoutNonce.payload)).not.toContain("nonce");
  });

  it("produces byte-identical signing input for the same inputs", () => {
    const first = createSigningInput(assertionJwt(issuer, "user-1", request));
    const second = createSigningInput(assertionJwt(issuer, "user-1", request));
    expect(first.signingInput).toEqual(second.signingInput);
    expect(first.headerB64).toBe(second.headerB64);
    expect(first.payloadB64).toBe(second.payloadB64);
  });
});

describe("accessTokenJwt", () => {
  const claims: AccessTokenClaims = { iat: 1000, exp: 2000, jti: "jti-1" };

  it("builds the documented header and payload from the credential", () => {
    const jwt = accessTokenJwt(issuer, credential, claims);
    expect(jwt.header).toEqual({ alg: "EdDSA", typ: ACCESS_TOKEN_TYP, kid: "key-1" });
    expect(jwt.payload).toEqual({
      iss: "https://issuer.example",
      sub: "user-1",
      aud: "client-1",
      scope: "openid profile",
      cnf: { jkt: "thumbprint-1" },
      iat: 1000,
      exp: 2000,
      jti: "jti-1",
    });
  });

  it("produces byte-identical signing input for the same inputs", () => {
    const first = createSigningInput(accessTokenJwt(issuer, credential, claims));
    const second = createSigningInput(accessTokenJwt(issuer, credential, claims));
    expect(first.signingInput).toEqual(second.signingInput);
  });
});

describe("refreshTokenJwt", () => {
  it("builds the documented header and payload from the credential", () => {
    const jwt = refreshTokenJwt(issuer, credential, 1000, 2000);
    expect(jwt.header).toEqual({ alg: "EdDSA", typ: REFRESH_TOKEN_TYP, kid: "key-1" });
    expect(jwt.payload).toEqual({
      iss: "https://issuer.example",
      sub: "user-1",
      cnf: { jkt: "thumbprint-1" },
      client_id: "client-1",
      scope: "openid profile",
      iat: 1000,
      exp: 2000,
    });
  });

  it("produces byte-identical signing input for the same inputs", () => {
    const first = createSigningInput(refreshTokenJwt(issuer, credential, 1000, 2000));
    const second = createSigningInput(refreshTokenJwt(issuer, credential, 1000, 2000));
    expect(first.signingInput).toEqual(second.signingInput);
  });
});

describe("credentialClaimsOf", () => {
  const payload = {
    sub: "user-1",
    client_id: "client-1",
    scope: "openid profile",
    cnf: { jkt: "thumbprint-1" },
  };

  it("reads sub, client_id, scope and cnf.jkt", () => {
    expect(credentialClaimsOf(payload)).toEqual({
      sub: "user-1",
      client_id: "client-1",
      scope: "openid profile",
      cnf: { jkt: "thumbprint-1" },
    });
  });

  it("treats a missing scope as an empty string", () => {
    const { scope: _scope, ...withoutScope } = payload;
    expect(credentialClaimsOf(withoutScope).scope).toBe("");
  });

  it("treats a non-string scope as an empty string", () => {
    expect(credentialClaimsOf({ ...payload, scope: 42 }).scope).toBe("");
  });

  it("throws naming sub when it is missing", () => {
    const { sub: _sub, ...withoutSub } = payload;
    expect(() => credentialClaimsOf(withoutSub)).toThrowError(/sub is missing/);
  });

  it("throws naming client_id when it is missing", () => {
    const { client_id: _clientId, ...withoutClientId } = payload;
    expect(() => credentialClaimsOf(withoutClientId)).toThrowError(/client_id is missing/);
  });

  it("throws naming cnf.jkt when it is missing", () => {
    const { cnf: _cnf, ...withoutCnf } = payload;
    expect(() => credentialClaimsOf(withoutCnf)).toThrowError(/cnf\.jkt is missing/);
  });

  it("throws naming cnf.jkt when it is not a string", () => {
    expect(() => credentialClaimsOf({ ...payload, cnf: { jkt: 42 } })).toThrowError(/cnf\.jkt is missing/);
  });
});

describe("decodeJwt with tokens built by assembleJwt", () => {
  it("returns the header and payload", () => {
    const jwt = assertionJwt(issuer, "user-1", {
      clientId: "client-1",
      scope: "openid",
      cnfJkt: "thumbprint-1",
      iat: 1000,
      exp: 2000,
    });
    const { headerB64, payloadB64 } = createSigningInput(jwt);
    const token = assembleJwt(headerB64, payloadB64, new Uint8Array(64));

    const decoded = decodeJwt(token);
    expect(decoded.header).toEqual(jwt.header);
    expect(decoded.payload).toEqual(jwt.payload);
  });

  it("rejects a 2-part string", () => {
    expect(() => decodeJwt("only.two")).toThrowError(/expected 3 parts/);
  });
});
