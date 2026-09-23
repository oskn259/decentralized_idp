import { SignRequest, SignResponseWire, signResponse } from "@decentralized-idp/sdk/node-api";
import { z } from "zod";
import { IdentityNode } from "../../domain/usecase/identity-node.js";
import { issueTokens } from "../../domain/usecase/issue-tokens.js";
import { DemoLog, shortValue } from "../demo-log.js";

/**
 * `POST /sign`: FROST round 2 for the access token and the refresh token.
 * Exactly the credential field the grant names is read; the other is ignored. The schema's
 * refine guarantees that field is present, so the cast below cannot meet `undefined`.
 */
export function signEndpoint(node: IdentityNode, { roundId, refreshRoundId, request }: SignRequest, demo: DemoLog): SignResponseWire {
  const credential = (request.grant === "authorization_code" ? request.assertion : request.refreshToken) as string;
  const shares = issueTokens(node, {
    accessRoundId: roundId,
    refreshRoundId,
    grant: request.grant,
    credential,
    dpopProof: request.dpopProof,
    claims: request.claims,
    commitments: request.commitments,
    refreshCommitments: request.refreshCommitments,
    allParticipants: request.allParticipants,
  });
  const res = z.encode(signResponse, { nodeId: shares.nodeId, at: shares.accessShare, rt: shares.refreshShare });

  const id = node.identity.nodeId;
  const authz = request.grant === "authorization_code";
  const signature = shortValue(credential.split(".")[2] ?? "");
  const grant = authz ? "authz" : "refresh";
  const presented = authz ? `assertion σ ${signature} ✓` : `refresh_token σ ${signature} ✓ (typ=refresh+jwt)`;
  const rt = authz ? "rt(refresh+jwt)" : "rt";
  demo.event(
    "sign",
    `round=${shortValue(roundId)} grant=${grant}  ← ${presented}  ` +
      `DPoP ✓ jti ${shortValue(shares.dpopJti)}  (D,E)×${request.allParticipants.length}  ` +
      `→ at z_${id} ${shortValue(res.at)} + ${rt} z_${id} ${shortValue(res.rt)}`
  );
  return res;
}
