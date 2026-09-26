import { User } from "../entity/user.js";

/** A username or a sub that another user already holds. */
export class AlreadyRegisteredError extends Error {
  constructor(field: "username" | "sub", value: string) {
    super(`${field} ${value} is taken`);
  }
}

export interface UserRepository {
  findByUsername(username: string): User | undefined;
  /** Throws `AlreadyRegisteredError` when the username or the sub is already registered. */
  insert(user: User): void;
}
