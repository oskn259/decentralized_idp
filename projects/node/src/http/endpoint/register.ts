import { RegisterRequest, RegisterResponseWire, registerResponse } from "@decentralized-idp/sdk/node-api";
import { z } from "zod";
import { IdentityNode } from "../../domain/usecase/identity-node.js";
import { register } from "../../domain/usecase/register.js";
import { DemoLog } from "../demo-log.js";

/** `POST /register`: store this node's share of a new user. */
export function registerEndpoint(node: IdentityNode, request: RegisterRequest, demo: DemoLog): RegisterResponseWire {
  register(node, request);
  demo.event("register", `user=${request.username} sub=${request.sub}  ← sealed share (opened here) → stored`);
  return z.encode(registerResponse, { nodeId: node.identity.nodeId });
}
