import type { QualityProfile, QualityRepository } from "@tessatv/domain";
import { eq } from "drizzle-orm";
import type { Database } from "./db.js";
import { toDomainQualityDefinition, toDomainQualityProfile } from "./mappers.js";
import { qualityDefinition as qualityDefinitionTable, qualityProfile as qualityProfileTable } from "./schema.js";

export class DrizzleQualityRepository implements QualityRepository {
  constructor(private readonly db: Database) {}

  async listDefinitions() {
    const rows = await this.db.select().from(qualityDefinitionTable);
    return rows.map(toDomainQualityDefinition);
  }

  async listProfiles() {
    const rows = await this.db.select().from(qualityProfileTable);
    return rows.map(toDomainQualityProfile);
  }

  async getProfile(id: string): Promise<QualityProfile | null> {
    const [row] = await this.db.select().from(qualityProfileTable).where(eq(qualityProfileTable.id, id));
    return row ? toDomainQualityProfile(row) : null;
  }
}
