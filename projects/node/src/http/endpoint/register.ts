import { RegisterRequest, RegisterResponseWire, registerResponse } from "@decentralized-idp/sdk/node-api";
import { z } from "zod";
import { IdentityNode } from "../../domain/usecase/identity-node.js";
import { register } from "../../domain/usecase/register.js";
import { DemoLog } from "../demo-log.js";

/** `POST /register`: store this node's share of a new user, sent by the browser. Never logs k_i or h_i. */
export function registerEndpoint(node: IdentityNode, request: RegisterRequest, demo: DemoLog): RegisterResponseWire {
  register(node, request);
  demo.event("register", `user=${request.username} sub=${request.sub}  ← k_i, h_i (from the browser, not via the gateway) → stored`);
  return z.encode(registerResponse, { nodeId: node.identity.nodeId });
}
