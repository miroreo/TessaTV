import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { LibraryFolderRepository, LibraryFolderSummary } from "@tessatv/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { LibraryScanner } from "../library-scanner.js";

export interface LibraryFolderDependencies {
  readonly folders: LibraryFolderRepository;
  readonly scanner: LibraryScanner;
}

/** Changing what the server reads from disk is an admin's call. */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user?.isAdmin) return reply.code(403).send({ error: "forbidden", message: "Admins only" });
}

const reachable = (path: string) => readdir(path).then(() => true, () => false);

export function registerLibraryFolderRoutes(server: FastifyInstance, deps: LibraryFolderDependencies): void {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const admin = { preHandler: requireAdmin };

  app.get("/api/library/folders", admin, async (): Promise<LibraryFolderSummary[]> => {
    const folders = await deps.folders.list();
    return Promise.all(
      folders.map(async ({ id, mediaType, path }) => ({ id, mediaType, path, reachable: await reachable(path) })),
    );
  });

  app.post(
    "/api/library/folders",
    {
      ...admin,
      schema: { body: z.object({ mediaType: z.enum(["movie", "series"]), path: z.string().trim().min(1) }) },
    },
    async (request, reply) => {
      const path = normalize(request.body.path).replace(/(.)\/+$/, "$1");
      if (!isAbsolute(path)) return reply.code(400).send({ error: "invalid_path", message: "Use an absolute path, e.g. /media/shows" });
      const isDirectory = await stat(path).then((info) => info.isDirectory(), () => false);
      if (!isDirectory) {
        return reply.code(400).send({ error: "invalid_path", message: `${path} isn't a folder the server can see` });
      }
      if ((await deps.folders.list()).some((folder) => folder.path === path)) {
        return reply.code(409).send({ error: "duplicate", message: `${path} is already a library folder` });
      }
      const folder = { id: randomUUID(), mediaType: request.body.mediaType, path, createdAt: new Date() };
      await deps.folders.add(folder);
      // Pick up its contents now rather than at the next 15-minute tick.
      void deps.scanner.scan();
      return reply.code(201).send({ id: folder.id, mediaType: folder.mediaType, path, reachable: true } satisfies LibraryFolderSummary);
    },
  );

  // Only stops future scans from reading it: what's already in the library stays.
  app.delete("/api/library/folders/:id", { ...admin, schema: { params: z.object({ id: z.string() }) } }, async (request, reply) => {
    await deps.folders.remove(request.params.id);
    return reply.code(204).send();
  });

  app.get("/api/library/scan", admin, async () => deps.scanner.status());

  /** Starts a scan (or joins the running one) and returns at once; poll `GET` for the result. */
  app.post("/api/library/scan", admin, async (_request, reply) => {
    void deps.scanner.scan();
    return reply.code(202).send(deps.scanner.status());
  });
}
