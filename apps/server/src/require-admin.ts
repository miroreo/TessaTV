import type { FastifyReply, FastifyRequest } from "fastify";

/** A preHandler for routes only an admin may use (library folders, stream stats). */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user?.isAdmin) return reply.code(403).send({ error: "forbidden", message: "Admins only" });
}
