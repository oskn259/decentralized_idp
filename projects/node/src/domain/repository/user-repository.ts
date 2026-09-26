import { User } from "../entity/user.js";

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username ${username} is taken`);
  }
}

export interface UserRepository {
  findByUsername(username: string): User | undefined;
  /** Throws `UsernameTakenError` when the username is already registered. */
  insert(user: User): void;
}
