import type { AuthService } from "@tessatv/auth";
import type {
  FileHealthRepository,
  LibraryRepository,
  LoudnessRepository,
  SubtitleRepository,
  MediaAvailabilityRepository,
  MetadataCacheRepository,
  ServerSettingsRepository,
  UserRepository,
  WatchProgressRepository,
} from "@tessatv/domain";
import { type JellyfinCompatOptions, registerJellyfinCompat } from "@tessatv/jellyfin-compat";
import type { MetadataProvidersByKind } from "@tessatv/library";
import fastifyCookie from "@fastify/cookie";
import type { TranscodeManager } from "@tessatv/streaming";
import Fastify, { type FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors, validatorCompiler } from "fastify-type-provider-zod";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBrowseRoutes } from "./routes/browse.js";
import { Catalog } from "./routes/catalog.js";
import { type LibraryFolderDependencies, registerLibraryFolderRoutes } from "./routes/library-folders.js";
import { registerLibraryImportRoutes } from "./routes/library-import.js";
import { registerLibraryMergeRoutes } from "./routes/library-merge.js";
import { registerLibraryMetadataRoutes } from "./routes/library-metadata.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerPlaybackRoutes, type PlaybackDependencies } from "./routes/playback.js";
import { type JellyfinImportDependencies, registerJellyfinImportRoutes } from "./routes/jellyfin-import.js";
import { registerOidcRoutes } from "./routes/oidc.js";
import { registerDiagnosticsRoutes, type DiagnosticsDependencies } from "./routes/diagnostics.js";
import { registerFileHealthRoutes, type FileHealthDependencies } from "./routes/file-health.js";
import { registerServerSettingsRoutes } from "./routes/server-settings.js";
import { oidcClientConfig, type SsoDependencies } from "./sso.js";
import { type NodeRequestHandler, registerWebUiRoutes } from "./routes/web-ui.js";

export interface AppDependencies {
  libraryRepository: LibraryRepository;
  /** Default provider per media kind — e.g. `{ movie: tmdb, series: tvdb }`. A kind with
   * no entry means that kind's metadata routes return 503 until it's configured. */
  metadataProviders: MetadataProvidersByKind;
  /** Enables login and locks down every `/api` route behind it. Omitted only in tests of
   * individual routes that don't involve auth. */
  auth?: AuthService;
  /** Mounts the Jellyfin-compatible API at the root. Omitted only in tests that don't need it. */
  jellyfin?: JellyfinCompatOptions;
  /** Browsing, playback and watch progress. These are per-user, so they're only mounted
   * together with `auth`. */
  playback?: {
    progressRepository: WatchProgressRepository;
    metadataCache: MetadataCacheRepository | null;
    transcodes: TranscodeManager;
    loudnessRepository?: LoudnessRepository;
    fileHealthRepository?: FileHealthRepository;
    subtitleRepository?: SubtitleRepository;
    /** Hides titles whose files have all gone missing. Without it, every title shows. */
    availability?: MediaAvailabilityRepository;
    probe?: PlaybackDependencies["probe"];
    extractSubtitles?: PlaybackDependencies["extractSubtitles"];
  };
  /** Server-wide settings (admin-only routes, mounted with `auth`); playback applies them. */
  settings?: ServerSettingsRepository;
  /** Lists accounts on the settings page. */
  users?: UserRepository;
  /** Single sign-on; mounted with `auth`, configured in `settings`. */
  sso?: SsoDependencies;
  /** Import watch history from a Jellyfin server; admin-only routes, mounted with `auth` and `settings`. */
  jellyfinImport?: JellyfinImportDependencies;
  /** Library folder settings and scanning; admin-only routes, mounted together with `auth`. */
  libraryFolders?: LibraryFolderDependencies;
  /** The background decode check's status page; admin-only, mounted with `auth` and `settings`. */
  fileHealth?: Omit<FileHealthDependencies, "settings">;
  /** Memory diagnostics routes (admin-only, mounted with `auth`); omitted unless enabled. */
  diagnostics?: DiagnosticsDependencies;
  /** SvelteKit's built handler, served at the root for any path no explicit route claims. Omitted when the web app isn't built. */
  webUiHandler?: NodeRequestHandler;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  // Case-insensitive routing is required by Jellyfin clients (see registerJellyfinCompat);
  // it applies router-wide, so TessaTV's own /api routes match case-insensitively too.
  const app = Fastify({ logger: true, routerOptions: { caseSensitive: false } });

  // Routes declare zod schemas; a request that fails one gets a uniform 400.
  app.setValidatorCompiler(validatorCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: "invalid_request", message: error.message, issues: error.validation });
    }
    return reply.send(error);
  });

  app.register(fastifyCookie);

  app.get("/health", async () => ({ status: "ok" }));

  if (deps.auth) {
    const sso = deps.sso;
    registerAuthRoutes(
      app,
      deps.auth,
      sso
        ? async () => {
            const { oidc } = await sso.settings.get();
            return oidcClientConfig(oidc, sso.clientSecrets) ? oidc!.buttonLabel : null;
          }
        : undefined,
    );
    if (sso) registerOidcRoutes(app, deps.auth, sso);
  }
  registerLibraryRoutes(app, deps.libraryRepository);
  registerLibraryImportRoutes(app, deps.libraryRepository, deps.metadataProviders);
  registerLibraryMetadataRoutes(app, deps.libraryRepository, deps.metadataProviders);
  registerLibraryMergeRoutes(app, deps.libraryRepository, deps.metadataProviders);

  if (deps.auth && deps.playback) {
    const catalog = new Catalog(deps.playback.metadataCache);
    const shared = { libraryRepository: deps.libraryRepository, progressRepository: deps.playback.progressRepository, catalog };
    registerBrowseRoutes(app, { ...shared, ...(deps.playback.availability ? { availability: deps.playback.availability } : {}) });
    registerPlaybackRoutes(app, { ...shared, ...deps.playback, ...(deps.settings ? { settings: deps.settings } : {}) });
  }

  if (deps.auth && deps.libraryFolders) registerLibraryFolderRoutes(app, deps.libraryFolders);
  if (deps.auth && deps.settings) {
    registerServerSettingsRoutes(app, {
      settings: deps.settings,
      ...(deps.users ? { users: deps.users } : {}),
      ...(deps.sso ? { sso: { client: deps.sso.client, clientSecrets: deps.sso.clientSecrets } } : {}),
      ...(deps.jellyfinImport ? { jellyfin: { apiKeys: deps.jellyfinImport.apiKeys, sourceFor: deps.jellyfinImport.sourceFor } } : {}),
    });
    if (deps.jellyfinImport) registerJellyfinImportRoutes(app, deps.jellyfinImport);
    if (deps.fileHealth) registerFileHealthRoutes(app, { ...deps.fileHealth, settings: deps.settings });
  }
  if (deps.auth && deps.diagnostics) registerDiagnosticsRoutes(app, deps.diagnostics);

  if (deps.jellyfin) registerJellyfinCompat(app, deps.jellyfin);
  if (deps.webUiHandler) registerWebUiRoutes(app, deps.webUiHandler);

  return app;
}
