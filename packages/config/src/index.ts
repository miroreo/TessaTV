import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8096),
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters (used to derive credential encryption key)"),
  // Optional: each provider's metadata features are disabled (not absent/erroring) until
  // its key is provided.
  TMDB_API_KEY: z.string().min(1).optional(),
  TVDB_API_KEY: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

/** Fails fast on invalid/missing config at startup rather than limping along partially configured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
