import type { HardwareAccelStatusResponse } from "@tessatv/domain";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../require-admin.js";

export interface HardwareAccelDependencies {
  readonly current: () => Promise<{ readonly kind: string; readonly device?: string | null; readonly deviceName: string | null }>;
  readonly listDevices: () => Promise<readonly string[]>;
}

/** Which devices the settings page offers and what transcodes use now. Admin-only. */
export function registerHardwareAccelRoutes(app: FastifyInstance, deps: HardwareAccelDependencies): void {
  app.get("/api/hardware-accel", { preHandler: requireAdmin }, async (): Promise<HardwareAccelStatusResponse> => {
    const [availableDevices, active] = await Promise.all([deps.listDevices(), deps.current()]);
    return { availableDevices, active: { kind: active.kind, device: active.device ?? null, deviceName: active.deviceName } };
  });
}
