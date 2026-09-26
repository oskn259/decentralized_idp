import { Commitment, FrostCommitment } from "@decentralized-idp/sdk/frost";
import { Clock } from "../infra/clock.js";
import { Node } from "../infra/node.js";
import { Client } from "../value/client.js";
import { Group } from "../value/group.js";

/** Everything a use case needs: the group, the nodes, the registered clients, the time. No user state, ever. */
export interface Gateway {
  group: Group;
  nodes: Node[];
  clients: Client[];
  clock: Clock;
}

/** FROST round 1 as the gateway sees it: who committed, to which rounds, and who did not. */
export interface OpenedRounds {
  /** Node ids that committed to every round, ascending. */
  participants: number[];
  /** One commitment set per requested round, in request order, sorted by node id. */
  commitments: FrostCommitment[][];
  /** Node ids that did not answer. */
  excluded: number[];
}

/**
 * Opens one or more FROST rounds on every node at once. A node that fails any of them is
 * left out of all of them, so the participant set is the same for every round; at least
 * `threshold` nodes must remain, or nothing can be signed.
 */
export async function openRounds(gateway: Gateway, roundIds: string[]): Promise<OpenedRounds> {
  const answers = await Promise.all(gateway.nodes.map((node) => commitToRounds(node, roundIds)));
  const committed = answers.filter((a) => a.commitments !== undefined).sort((a, b) => a.node.nodeId - b.node.nodeId);
  const excluded = answers.filter((a) => a.commitments === undefined).map((a) => a.node.nodeId).sort((a, b) => a - b);

  if (committed.length < gateway.group.threshold) {
    const names = excluded.map((id) => `node${id}`).join(", ");
    throw new Error(`quorum ${committed.length} < ${gateway.group.threshold}${names ? ` (${names} unreachable)` : ""}`);
  }

  return {
    participants: committed.map((a) => a.node.nodeId),
    commitments: roundIds.map((_, i) => committed.map((a) => ({ nodeId: a.node.nodeId, ...a.commitments![i] }))),
    excluded,
  };
}

/** One node's commitment to each round, in request order; undefined when any round failed. */
async function commitToRounds(node: Node, roundIds: string[]): Promise<{ node: Node; commitments: Commitment[] | undefined }> {
  const commitments = await Promise.all(roundIds.map((roundId) => node.commit(roundId))).catch(() => undefined);
  return { node, commitments };
}

/** The nodes named by `participants`, in that order. */
export function participantNodes(gateway: Gateway, ids: number[]): Node[] {
  return ids.map((id) => gateway.nodes.find((n) => n.nodeId === id)!);
}
