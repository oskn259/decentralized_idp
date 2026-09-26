import fs from "node:fs";
import { User } from "../domain/entity/user.js";
import { UserRepository, UsernameTakenError } from "../domain/repository/user-repository.js";
import { bigIntToHex, bytesToHex, hexToBigInt, hexToBytes } from "@decentralized-idp/sdk/hex";

/**
 * The registered users of this node, as `{ "version": 1, "users": [...] }`. Scalars are 64
 * lowercase hex digits, big-endian. A missing file means no users yet.
 */
interface UserRecord {
  username: string;
  sub: string;
  toprfKeyShare: { id: number; value: string };
  h_i: string;
}

function userOf(record: UserRecord): User {
  return {
    username: record.username,
    sub: record.sub,
    toprfKeyShare: { id: record.toprfKeyShare.id, value: hexToBigInt(record.toprfKeyShare.value) },
    h_i: hexToBytes(record.h_i),
  };
}

function recordOf(user: User): UserRecord {
  return {
    username: user.username,
    sub: user.sub,
    toprfKeyShare: { id: user.toprfKeyShare.id, value: bigIntToHex(user.toprfKeyShare.value) },
    h_i: bytesToHex(user.h_i),
  };
}

function readUsers(path: string): User[] {
  if (!fs.existsSync(path)) return [];
  const file = JSON.parse(fs.readFileSync(path, "utf8")) as { users: UserRecord[] };
  return file.users.map(userOf);
}

function writeUsers(path: string, users: User[]): void {
  fs.writeFileSync(`${path}.tmp`, JSON.stringify({ version: 1, users: users.map(recordOf) }, null, 2));
  fs.renameSync(`${path}.tmp`, path);
}

/** Held in memory, and the whole file rewritten on every insert: write `<path>.tmp`, then rename. */
export class FileUserRepository implements UserRepository {
  private readonly users: Map<string, User>;

  constructor(private readonly path: string) {
    this.users = new Map(readUsers(path).map((user) => [user.username, user]));
  }

  findByUsername(username: string): User | undefined {
    return this.users.get(username);
  }

  insert(user: User): void {
    if (this.users.has(user.username)) {
      throw new UsernameTakenError(user.username);
    }
    writeUsers(this.path, [...this.users.values(), user]);
    this.users.set(user.username, user);
  }
}
