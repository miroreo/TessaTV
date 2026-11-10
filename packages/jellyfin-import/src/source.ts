import { Jellyfin } from "@jellyfin/sdk";
import { BaseItemKind, ItemFields, ItemFilter, type BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models/index.js";
import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api/library-api.js";
import { getUserApi } from "@jellyfin/sdk/lib/utils/api/user-api.js";

export interface JellyfinUser {
  readonly id: string;
  readonly name: string;
}

export interface JellyfinSeries {
  readonly id: string;
  /** Keys lower-cased: `tmdb`, `tvdb`, `imdb`, ... */
  readonly providerIds: Readonly<Record<string, string>>;
}

/** A movie or episode one Jellyfin user has played or started. */
export interface JellyfinItem {
  readonly id: string;
  readonly type: "Movie" | "Episode";
  /** The file's path as the Jellyfin server sees it. */
  readonly path: string | null;
  readonly providerIds: Readonly<Record<string, string>>;
  readonly seriesId: string | null;
  readonly seasonNumber: number | null;
  readonly episodeNumber: number | null;
  readonly runtimeSeconds: number | null;
  readonly played: boolean;
  readonly positionSeconds: number;
  readonly lastPlayedAt: Date | null;
}

/** What the import needs from a Jellyfin server — the SDK behind an interface so tests can fake it. */
export interface JellyfinHistorySource {
  listUsers(): Promise<JellyfinUser[]>;
  listSeries(): Promise<JellyfinSeries[]>;
  listHistory(userId: string): Promise<JellyfinItem[]>;
}

const TICKS_PER_SECOND = 10_000_000;
const PAGE_SIZE = 1000;

export function lowerCaseKeys(ids: BaseItemDto["ProviderIds"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ids ?? {})) if (value) out[key.toLowerCase()] = value;
  return out;
}

export function toJellyfinItem(dto: BaseItemDto): JellyfinItem | null {
  if (!dto.Id || (dto.Type !== "Movie" && dto.Type !== "Episode")) return null;
  const userData = dto.UserData;
  return {
    id: dto.Id,
    type: dto.Type,
    path: dto.Path ?? null,
    providerIds: lowerCaseKeys(dto.ProviderIds),
    seriesId: dto.SeriesId ?? null,
    seasonNumber: dto.ParentIndexNumber ?? null,
    episodeNumber: dto.IndexNumber ?? null,
    runtimeSeconds: dto.RunTimeTicks ? dto.RunTimeTicks / TICKS_PER_SECOND : null,
    played: userData?.Played ?? false,
    positionSeconds: (userData?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND,
    lastPlayedAt: userData?.LastPlayedDate ? new Date(userData.LastPlayedDate) : null,
  };
}

/** Talks to a real Jellyfin server through the official SDK, with an API key. */
export class JellyfinSdkSource implements JellyfinHistorySource {
  private readonly api;

  constructor(url: string, apiKey: string) {
    const jellyfin = new Jellyfin({
      clientInfo: { name: "TessaTV", version: "1" },
      deviceInfo: { name: "TessaTV watch history import", id: "tessatv-import" },
    });
    this.api = jellyfin.createApi(url, apiKey);
  }

  async listUsers(): Promise<JellyfinUser[]> {
    const { data } = await getUserApi(this.api).getUsers();
    return data.flatMap((user) => (user.Id && user.Name ? [{ id: user.Id, name: user.Name }] : []));
  }

  async listSeries(): Promise<JellyfinSeries[]> {
    const items = await this.pages({ recursive: true, includeItemTypes: [BaseItemKind.Series], fields: [ItemFields.ProviderIds], enableUserData: false });
    return items.flatMap((dto) => (dto.Id ? [{ id: dto.Id, providerIds: lowerCaseKeys(dto.ProviderIds) }] : []));
  }

  async listHistory(userId: string): Promise<JellyfinItem[]> {
    const seen = new Map<string, JellyfinItem>();
    // Two filtered queries instead of the whole library: finished things, and things in progress.
    for (const filter of [ItemFilter.IsPlayed, ItemFilter.IsResumable]) {
      const dtos = await this.pages({
        userId,
        recursive: true,
        includeItemTypes: [BaseItemKind.Movie, BaseItemKind.Episode],
        fields: [ItemFields.Path, ItemFields.ProviderIds],
        filters: [filter],
        enableUserData: true,
      });
      for (const dto of dtos) {
        const item = toJellyfinItem(dto);
        if (item) seen.set(item.id, item);
      }
    }
    return [...seen.values()];
  }

  private async pages(query: Parameters<ReturnType<typeof getLibraryApi>["getItems"]>[0]): Promise<BaseItemDto[]> {
    const all: BaseItemDto[] = [];
    for (let startIndex = 0; ; startIndex += PAGE_SIZE) {
      const { data } = await getLibraryApi(this.api).getItems({ ...query, startIndex, limit: PAGE_SIZE });
      const items = data.Items ?? [];
      all.push(...items);
      if (items.length < PAGE_SIZE || all.length >= (data.TotalRecordCount ?? 0)) return all;
    }
  }
}
