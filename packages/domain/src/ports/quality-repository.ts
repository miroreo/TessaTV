import type { QualityDefinition, QualityProfile } from "../quality.js";

export interface QualityRepository {
  listDefinitions(): Promise<QualityDefinition[]>;
  listProfiles(): Promise<QualityProfile[]>;
  getProfile(id: string): Promise<QualityProfile | null>;
}
