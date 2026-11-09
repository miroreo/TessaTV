import type { AuthSession, User } from "../user.js";

export interface UserRepository {
  countUsers(): Promise<number>;
  getUser(id: string): Promise<User | null>;
  /** Case-insensitive. */
  getUserByUsername(username: string): Promise<User | null>;
  /**
   * Creates `user` only if no users exist yet, atomically — so two concurrent first-run
   * setup requests can't both create an admin. Returns whether it was created.
   */
  createFirstUser(user: User): Promise<boolean>;
  /** Throws if the username is already taken (case-insensitively). */
  createUser(user: User): Promise<void>;
  updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void>;
}

export interface AuthSessionRepository {
  createSession(session: AuthSession): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<AuthSession | null>;
  touchSession(id: string, lastSeenAt: Date): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
