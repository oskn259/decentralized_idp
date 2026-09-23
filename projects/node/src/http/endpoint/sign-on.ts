import { base64UrlEncode } from "@decentralized-idp/sdk/base64url";
import { SignOnRequest, SignOnResponseWire, signOnResponse } from "@decentralized-idp/sdk/node-api";
import { z } from "zod";
import { IdentityNode } from "../../domain/usecase/identity-node.js";
import { signOn } from "../../domain/usecase/sign-on.js";
import { DemoLog, shortValue } from "../demo-log.js";

/** `POST /sign-on`: FROST round 2 for the authentication assertion. */
export function signOnEndpoint(node: IdentityNode, { roundId, request }: SignOnRequest, demo: DemoLog): SignOnResponseWire {
  const res = z.encode(signOnResponse, signOn(node, { roundId, ...request }));

  const id = node.identity.nodeId;
  demo.event(
    "sign-on",
    `round=${shortValue(roundId)} user=${request.username}  ` +
      `← A ${shortValue(base64UrlEncode(request.blinded))}  (D,E)×${request.allParticipants.length}  ` +
      `nonce_s ${shortValue(base64UrlEncode(request.sessionNonce))}  jkt ${shortValue(request.cnfJkt)}`
  );
  demo.more(`→ B_${id}=k_${id}·A ${shortValue(res.toprfPartial)}  ct_${id}=AEAD_h${id}(z_${id}) ${shortValue(res.ct_i)}`);
  return res;
}
