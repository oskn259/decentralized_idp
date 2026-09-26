import { SignRequest, SignResponseWire, signResponse } from "@decentralized-idp/sdk/node-api";
import { admit, charge } from "@decentralized-idp/sdk/x402";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { Context } from "hono";
import { z } from "zod";
import { authenticateCaller } from "../../domain/usecase/caller.js";
import { IdentityNode } from "../../domain/usecase/identity-node.js";
import { TokenRequest, issueTokens } from "../../domain/usecase/issue-tokens.js";
import { DemoLog, shortValue } from "../demo-log.js";

/**
 * `POST /sign`: FROST round 2 for the access token and the refresh token, sold to the
 * calling gateway as prepaid credit. The caller is authenticated first, then admitted on its
 * credit or its payment (402 otherwise), and charged one credit only when the tokens were
 * signed. None of this touches a round, so a refused or unpaid request can be retried on
 * the same rounds.
 */
export async function signEndpoint(c: Context, node: IdentityNode, body: SignRequest, demo: DemoLog): Promise<SignResponseWire | Response> {
  const callerId = authenticateCaller(node, body.request.clientAssertion);
  const { credits, settler, terms } = node.billing;
  const admission = await admit(credits, settler, terms, callerId, `${node.identity.publicUrl}/sign`, c.req.header("PAYMENT-SIGNATURE"));
  if (!admission.paid) {
    demo.reject("sign", `payment required: ${admission.reason}`);
    return c.json({ error: admission.reason }, 402, { "PAYMENT-REQUIRED": admission.paymentRequired });
  }
  if (admission.paymentResponse) {
    // Set before signing, so a refused request still tells the caller its payment went through.
    c.header("PAYMENT-RESPONSE", admission.paymentResponse);
    const tx = decodePaymentResponseHeader(admission.paymentResponse).transaction;
    demo.event("pay", `from=${callerId} +${terms.batch} credits (settled ${shortValue(tx)})`);
  }

  const shares = issueTokens(node, tokenRequestOf(body));
  charge(credits, callerId);
  const res = z.encode(signResponse, { nodeId: shares.nodeId, at: shares.accessShare, rt: shares.refreshShare });
  demo.event("sign", `${signLine(node, body, res, shares.dpopJti)} credits=${credits.balance(callerId)}`);
  return res;
}

/**
 * Exactly the credential field the grant names is read; the other is ignored. The schema's
 * refine guarantees that field is present, so the cast below cannot meet `undefined`.
 */
function credentialOf({ request }: SignRequest): string {
  return (request.grant === "authorization_code" ? request.assertion : request.refreshToken) as string;
}

function tokenRequestOf(body: SignRequest): TokenRequest {
  const { request } = body;
  return {
    accessRoundId: body.roundId,
    refreshRoundId: body.refreshRoundId,
    grant: request.grant,
    credential: credentialOf(body),
    dpopProof: request.dpopProof,
    claims: request.claims,
    commitments: request.commitments,
    refreshCommitments: request.refreshCommitments,
    allParticipants: request.allParticipants,
  };
}

function signLine(node: IdentityNode, body: SignRequest, res: SignResponseWire, dpopJti: string): string {
  const id = node.identity.nodeId;
  const authz = body.request.grant === "authorization_code";
  const signature = shortValue(credentialOf(body).split(".")[2] ?? "");
  const grant = authz ? "authz" : "refresh";
  const presented = authz ? `assertion σ ${signature} ✓` : `refresh_token σ ${signature} ✓ (typ=refresh+jwt)`;
  const rt = authz ? "rt(refresh+jwt)" : "rt";
  return (
    `round=${shortValue(body.roundId)} grant=${grant}  ← ${presented}  ` +
    `DPoP ✓ jti ${shortValue(dpopJti)}  (D,E)×${body.request.allParticipants.length}  ` +
    `→ at z_${id} ${shortValue(res.at)} + ${rt} z_${id} ${shortValue(res.rt)}`
  );
}
