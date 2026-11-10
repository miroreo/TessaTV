import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "@tessatv/auth";
import type {
  AuthSession,
  AuthSessionRepository,
  LibraryFolder,
  LibraryFolderRepository,
  LibraryNode,
  LibraryRepository,
  MediaFile,
  Unit,
  User,
  UserRepository,
} from "@tessatv/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { LibraryScanner } from "../library-scanner.js";

class Users implements UserRepository {
  users: User[] = [];
  async countUsers() {
    return this.users.length;
  }
  async getUserByOidcSubject(subject: string) {
    return this.users.find((user) => user.oidcSubject === subject) ?? null;
  }
  async listUsers() {
    return [...this.users];
  }
  async updateOidcLogin(id: string, changes: { oidcSubject: string; isAdmin: boolean; updatedAt: Date }) {
    const index = this.users.findIndex((user) => user.id === id);
    if (index >= 0) this.users[index] = { ...this.users[index]!, ...changes };
  }
  async getUser(id: string) {
    return this.users.find((user) => user.id === id) ?? null;
  }
  async getUserByUsername(username: string) {
    return this.users.find((user) => user.username === username) ?? null;
  }
  async createFirstUser(user: User) {
    this.users.push(user);
    return true;
  }
  async createUser(user: User) {
    this.users.push(user);
  }
  async updatePasswordHash() {}
}

class Sessions implements AuthSessionRepository {
  sessions: AuthSession[] = [];
  async createSession(session: AuthSession) {
    this.sessions.push(session);
  }
  async getSessionByTokenHash(tokenHash: string) {
    return this.sessions.find((session) => session.tokenHash === tokenHash) ?? null;
  }
  async touchSession() {}
  async deleteSession() {}
}

class Folders implements LibraryFolderRepository {
  folders: LibraryFolder[] = [];
  async list() {
    return this.folders;
  }
  async add(folder: LibraryFolder) {
    this.folders.push(folder);
  }
  async remove(id: string) {
    this.folders = this.folders.filter((folder) => folder.id !== id);
  }
}

class Library implements LibraryRepository {
  nodes: LibraryNode[] = [];
  units: Unit[] = [];
  async getNode(id: string) {
    return this.nodes.find((node) => node.id === id) ?? null;
  }
  async listChildren(parentId: string | null) {
    return this.nodes.filter((node) => node.parentId === parentId);
  }
  async createNode(node: LibraryNode) {
    this.nodes.push(node);
  }
  async updateNode() {}
  async deleteNode() {}
  async getUnit(id: string) {
    return this.units.find((unit) => unit.id === id) ?? null;
  }
  async listUnits(libraryNodeId: string) {
    return this.units.filter((unit) => unit.libraryNodeId === libraryNodeId);
  }
  async createUnit(unit: Unit) {
    this.units.push(unit);
  }
  async updateUnit() {}
  async moveWatchProgress() {}
  async getMediaFile(): Promise<MediaFile | null> {
    return null;
  }
  async createMediaFile() {}
}

describe("library folder and scan routes", () => {
  let root: string;
  let app: ReturnType<typeof buildApp>;
  let headers: { authorization: string };
  const users = new Users();
  const folders = new Folders();
  const library = new Library();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tessatv-folders-test-"));
    await mkdir(join(root, "movies", "Example (1999)"), { recursive: true });
    await writeFile(join(root, "movies", "Example (1999)", "Example.mkv"), "x");
    await writeFile(join(root, "not-a-folder"), "x");
    const auth = new AuthService(users, new Sessions());
    const { token } = await auth.completeSetup("admin", "a-long-enough-password", null);
    headers = { authorization: `Bearer ${token}` };
    const availability = { listFilesUnder: async () => [], setAvailability: async () => {}, deleteUnlinkedMediaFiles: async () => 0, listRootsWithPlayableUnits: async () => new Set<string>() };
    const scanner = new LibraryScanner({ folders, repository: library, availability, providers: {} });
    app = buildApp({ libraryRepository: library, metadataProviders: {}, auth, libraryFolders: { folders, scanner } });
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("validates new folders: absolute, an existing directory, not a duplicate", async () => {
    const add = (path: string) => app.inject({ method: "POST", url: "/api/library/folders", headers, payload: { mediaType: "movie", path } });
    expect((await add("relative/movies")).statusCode).toBe(400);
    expect((await add(join(root, "nope"))).statusCode).toBe(400);
    expect((await add(join(root, "not-a-folder"))).statusCode).toBe(400);
    const created = await add(`${join(root, "movies")}/`);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ path: join(root, "movies"), reachable: true });
    expect((await add(join(root, "movies"))).statusCode).toBe(409);
  });

  it("scans on demand and reports the result", async () => {
    const started = await app.inject({ method: "POST", url: "/api/library/scan", headers });
    expect(started.statusCode).toBe(202);
    let status = started.json();
    for (let i = 0; i < 50 && (status.running || !status.lastScan); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (await app.inject({ method: "GET", url: "/api/library/scan", headers })).json();
    }
    expect(status.lastScan).toMatchObject({ moviesAdded: 1, error: null });
    expect(library.units).toHaveLength(1);
  });

  it("lists folders with reachability, and removes them", async () => {
    const listed = (await app.inject({ method: "GET", url: "/api/library/folders", headers })).json();
    expect(listed).toEqual([{ id: expect.any(String), mediaType: "movie", path: join(root, "movies"), reachable: true }]);
    expect((await app.inject({ method: "DELETE", url: `/api/library/folders/${listed[0].id}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/library/folders", headers })).json()).toEqual([]);
  });

  it("is admin-only", async () => {
    users.users = users.users.map((user) => ({ ...user, isAdmin: false }));
    expect((await app.inject({ method: "GET", url: "/api/library/folders", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/library/scan", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/library/folders" })).statusCode).toBe(401);
  });
});
