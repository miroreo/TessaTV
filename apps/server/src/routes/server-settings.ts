import { MAX_STREAM_HEIGHTS, type ServerSettings, type ServerSettingsRepository } from "@tessatv/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin } from "../require-admin.js";

const maxStreamHeight = z.union([z.null(), ...MAX_STREAM_HEIGHTS.map((height) => z.literal(height))] as const);

/** Server-wide settings: admin-only, like everything else on the settings page. */
export function registerServerSettingsRoutes(server: FastifyInstance, settings: ServerSettingsRepository): void {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const admin = { preHandler: requireAdmin };

  app.get("/api/settings", admin, async (): Promise<ServerSettings> => settings.get());

  app.patch(
    "/api/settings",
    { ...admin, schema: { body: z.object({ maxStreamHeight: maxStreamHeight.optional() }).strict() } },
    async (request): Promise<ServerSettings> => {
      const { maxStreamHeight: height } = request.body;
      return settings.update(height !== undefined ? { maxStreamHeight: height } : {});
    },
  );
}
