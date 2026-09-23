import { Share } from "@decentralized-idp/sdk/shamir";

/**
 * A registered user as this node knows them. The password itself and the master PRF
 * output h are never here: only this node's TOPRF share k_i and its derived key h_i.
 */
export interface User {
  username: string;
  sub: string;
  toprfKeyShare: Share;
  h_i: Uint8Array;
}
