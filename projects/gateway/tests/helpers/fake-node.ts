import { Commitment, generateNonces } from "@decentralized-idp/sdk/frost";
import {
  Node,
  NodeHealth,
  NodeSignOnRequest,
  NodeSignOnResponse,
  NodeTokenRequest,
  NodeTokenShares,
} from "../../src/domain/infra/node.js";

/**
 * A `Node` a test drives directly: no HTTP, controllable failures, and every call recorded
 * so a test can assert what it was sent. `commit` still returns real FROST commitment
 * points (from `generateNonces`), because `issueTokens`/`signOn` aggregate a real Ed25519
 * signature from them -- fixed dummy bytes would not decode as curve points.
 */
export interface FakeNodeOptions {
  /** `true` for a generic failure, or the exact message the call should throw. */
  commitFails?: boolean | string;
  signOnFails?: boolean | string;
  signFails?: boolean | string;
  healthFails?: boolean | string;
  sub?: string;
  groupPublicKey?: Uint8Array;
  /** Answers `commit` with bytes that are not valid Ed25519 curve points, instead of failing outright. */
  commitCorrupt?: boolean;
}

export class FakeNode implements Node {
  readonly commitCalls: string[] = [];
  readonly signOnCalls: NodeSignOnRequest[] = [];
  readonly signCalls: NodeTokenRequest[] = [];

  constructor(
    readonly nodeId: number,
    private readonly opts: FakeNodeOptions = {},
    readonly url = `http://fake-node-${nodeId}.test`,
    readonly publicUrl = `http://fake-node-${nodeId}.test`
  ) {}

  async commit(roundId: string): Promise<Commitment> {
    this.commitCalls.push(roundId);
    if (this.opts.commitFails) throw failure(this.opts.commitFails, `node ${this.nodeId} commit failed`);
    if (this.opts.commitCorrupt) return { D: new Uint8Array(32).fill(1), E: new Uint8Array(32).fill(2) };
    return generateNonces().commitment;
  }

  async signOn(request: NodeSignOnRequest): Promise<NodeSignOnResponse> {
    this.signOnCalls.push(request);
    if (this.opts.signOnFails) throw failure(this.opts.signOnFails, `node ${this.nodeId} sign-on failed`);
    const filler = new Uint8Array(32).fill(this.nodeId);
    return { nodeId: this.nodeId, toprfPartial: filler, ct_i: filler, sub: this.opts.sub ?? `usr_fake_${this.nodeId}` };
  }

  async sign(request: NodeTokenRequest): Promise<NodeTokenShares> {
    this.signCalls.push(request);
    if (this.opts.signFails) throw failure(this.opts.signFails, `node ${this.nodeId} sign refused`);
    return { nodeId: this.nodeId, accessShare: BigInt(this.nodeId + 1), refreshShare: BigInt(this.nodeId + 101) };
  }

  async health(): Promise<NodeHealth> {
    if (this.opts.healthFails) throw failure(this.opts.healthFails, `node ${this.nodeId} unhealthy`);
    return {
      nodeId: this.nodeId,
      groupPublicKey: this.opts.groupPublicKey ?? new Uint8Array(32).fill(this.nodeId),
      publicUrl: this.publicUrl,
    };
  }
}

function failure(spec: boolean | string, fallback: string): Error {
  return new Error(typeof spec === "string" ? spec : fallback);
}
