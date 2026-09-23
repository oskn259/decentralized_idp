import { CommitRequest, CommitResponseWire, commitResponse } from "@decentralized-idp/sdk/node-api";
import { z } from "zod";
import { commit } from "../../domain/usecase/commit.js";
import { IdentityNode } from "../../domain/usecase/identity-node.js";
import { DemoLog, shortValue } from "../demo-log.js";

/** `POST /commit`: FROST round 1. */
export function commitEndpoint(node: IdentityNode, { roundId }: CommitRequest, demo: DemoLog): CommitResponseWire {
  const id = node.identity.nodeId;
  const { D, E } = commit(node, roundId);
  const out = z.encode(commitResponse, { nodeId: id, D, E });
  demo.event("commit", `round=${shortValue(roundId)}  → D_${id},E_${id} ${shortValue(out.D)} ${shortValue(out.E)}`);
  return out;
}
