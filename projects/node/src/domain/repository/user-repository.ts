import { User } from "../entity/user.js";

export interface UserRepository {
  findByUsername(username: string): User | undefined;
}
