import type { FastifyInstance } from "fastify";
import { memoryReport, type MemoryDiagnostics, type MemoryReport } from "../diagnostics.js";
import { requireAdmin } from "../require-admin.js";

export interface DiagnosticsDependencies {
  readonly diagnostics: MemoryDiagnostics;
}

/**
 * Memory diagnostics, for chasing a leak in the running server. Mounted only when
 * `DIAGNOSTICS_DIR` is set, and admin-only: a snapshot holds everything in memory,
 * including session tokens and settings.
 */
export function registerDiagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsDependencies): void {
  const admin = { preHandler: requireAdmin };

  app.get("/api/diagnostics/memory", admin, async (): Promise<MemoryReport> => memoryReport());

  /** Where the live memory was allocated, from the sampling profiler — quick and safe to run anytime. */
  app.post("/api/diagnostics/heap-profile", admin, async () => ({ path: await deps.diagnostics.captureProfile() }));

  /** A full heap snapshot. Blocks the whole server for several seconds on a big heap. */
  app.post("/api/diagnostics/heap-snapshot", admin, async () => ({ path: deps.diagnostics.captureSnapshot() }));
}
