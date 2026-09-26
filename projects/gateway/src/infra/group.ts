import fs from "node:fs";
import { hexToBytes } from "@decentralized-idp/sdk/hex";
import { Group } from "../domain/value/group.js";

/** What distKey writes for the gateway. `groupPublicKey` is lowercase hex. */
interface GroupFile {
  threshold: number;
  keyId: string;
  groupPublicKey: string;
}

export function parseGroup(text: string, issuer: string): Group {
  const file = JSON.parse(text) as GroupFile;
  return { issuer, threshold: file.threshold, keyId: file.keyId, groupPublicKey: hexToBytes(file.groupPublicKey) };
}

export function loadGroup(path: string, issuer: string): Group {
  return parseGroup(fs.readFileSync(path, "utf8"), issuer);
}
