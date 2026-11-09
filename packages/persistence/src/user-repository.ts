import type { AuthSession, AuthSessionRepository, User, UserRepository } from "@tessatv/domain";
import { count, eq, sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { appUser, authSession } from "./schema.js";

/** Arbitrary constant key for the first-run advisory lock. */
const FIRST_USER_LOCK_KEY = 7_160_001;

function toUser(row: typeof appUser.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async countUsers(): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(appUser);
    return row?.value ?? 0;
  }

  async getUser(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(appUser).where(eq(appUser.id, id));
    return row ? toUser(row) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(appUser)
      .where(eq(sql`lower(${appUser.username})`, username.toLowerCase()));
    return row ? toUser(row) : null;
  }

  async createFirstUser(user: User): Promise<boolean> {
    // A plain "insert where not exists" can race under READ COMMITTED — two transactions
    // both see an empty table. The transaction-scoped advisory lock serializes them.
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_USER_LOCK_KEY})`);
      const [existing] = await tx.select({ value: count() }).from(appUser);
      if ((existing?.value ?? 0) > 0) return false;
      await tx.insert(appUser).values(user);
      return true;
    });
  }

  async createUser(user: User): Promise<void> {
    await this.db.insert(appUser).values(user);
  }

  async updatePasswordHash(id: string, passwordHash: string, updatedAt: Date): Promise<void> {
    await this.db.update(appUser).set({ passwordHash, updatedAt }).where(eq(appUser.id, id));
  }
}

export class DrizzleAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly db: Database) {}

  async createSession(session: AuthSession): Promise<void> {
    await this.db.insert(authSession).values(session);
  }

  async getSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    const [row] = await this.db.select().from(authSession).where(eq(authSession.tokenHash, tokenHash));
    return row ?? null;
  }

  async touchSession(id: string, lastSeenAt: Date): Promise<void> {
    await this.db.update(authSession).set({ lastSeenAt }).where(eq(authSession.id, id));
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.delete(authSession).where(eq(authSession.id, id));
  }
}
