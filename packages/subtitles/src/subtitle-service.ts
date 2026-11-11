import Bottleneck from "bottleneck";
import { AuthFailedError, QuotaExhaustedError, RateLimitedError } from "./errors.js";
import { normalizeSubtitle, type SubtitleFile } from "./normalize.js";
import { rankCandidates, type ScoredCandidate, type SubtitleSlot } from "./score.js";
import type { SubtitleProvider, SubtitleQuery } from "./subtitle-provider.js";

export interface ProviderFailure {
  readonly provider: string;
  readonly error: unknown;
}

export interface FoundSubtitle extends SubtitleFile {
  readonly scored: ScoredCandidate;
}

export type FetchOutcome =
  | { readonly kind: "found"; readonly subtitle: FoundSubtitle; readonly failures: readonly ProviderFailure[] }
  /** Searched fine, but nothing good enough exists (yet). */
  | { readonly kind: "none"; readonly considered: number; readonly failures: readonly ProviderFailure[] }
  /** Every provider failed or is paused, so nothing was learned; try again later. */
  | { readonly kind: "unavailable"; readonly failures: readonly ProviderFailure[] };

export interface SubtitleServiceOptions {
  /** Pause between requests to one provider. Default 300 ms. */
  readonly minTimeMs?: number;
  /** How long a provider that said "slow down" with no time given sits out. Default 5 min. */
  readonly defaultPauseMs?: number;
  /** How many of the best candidates to try downloading before giving up. Default 3. */
  readonly maxDownloadAttempts?: number;
  readonly now?: () => Date;
}

/**
 * Everything that is the same for every provider, written once: requests to each provider go
 * through one shared limiter (so a library-wide backfill can't trip a rate limit), a provider
 * that reports a rate limit, spent quota or bad credentials is skipped until it's worth trying
 * again, candidates from all providers are ranked together, and downloads are decoded to UTF-8.
 * Adapters only translate wire formats; they never retry.
 */
export class SubtitleService {
  private readonly limiters = new Map<string, Bottleneck>();
  private readonly pausedUntil = new Map<string, number>();
  private readonly now: () => Date;

  constructor(
    private readonly providers: readonly SubtitleProvider[],
    private readonly options: SubtitleServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    for (const provider of providers) {
      this.limiters.set(provider.id, new Bottleneck({ maxConcurrent: 1, minTime: options.minTimeMs ?? 300 }));
    }
  }

  /** When a paused provider is next worth trying, for "retry after" scheduling; null if none is paused. */
  earliestResume(): Date | null {
    const times = [...this.pausedUntil.values()].filter((time) => time > this.now().getTime());
    return times.length > 0 ? new Date(Math.min(...times)) : null;
  }

  async search(query: SubtitleQuery, slot: SubtitleSlot): Promise<{ ranked: ScoredCandidate[]; failures: ProviderFailure[]; searched: number }> {
    const slotQuery: SubtitleQuery = { ...query, languages: [slot.language], forced: slot.forced };
    const failures: ProviderFailure[] = [];
    const active = this.providers.filter((provider) => !this.isPaused(provider.id));
    const results = await Promise.all(
      active.map(async (provider) => {
        try {
          return await this.run(provider, () => provider.search(slotQuery));
        } catch (error) {
          this.noteFailure(provider.id, error);
          failures.push({ provider: provider.id, error });
          return [];
        }
      }),
    );
    return { ranked: rankCandidates(results.flat(), slotQuery, slot), failures, searched: active.length };
  }

  /** Searches, then downloads the best candidate that is good enough and actually decodes. */
  async fetchBest(query: SubtitleQuery, slot: SubtitleSlot): Promise<FetchOutcome> {
    const { ranked, failures, searched } = await this.search(query, slot);
    const accepted = ranked.filter((scored) => scored.accepted);

    let attempts = 0;
    for (const scored of accepted) {
      if (attempts >= (this.options.maxDownloadAttempts ?? 3)) break;
      const provider = this.providers.find((p) => p.id === scored.candidate.provider);
      if (!provider || this.isPaused(provider.id)) continue;
      attempts++;
      try {
        const download = await this.run(provider, () => provider.download(scored.candidate));
        return { kind: "found", subtitle: { ...normalizeSubtitle(download), scored }, failures };
      } catch (error) {
        // A bad file (empty, unreadable archive) just means the next candidate gets a go.
        this.noteFailure(provider.id, error);
        failures.push({ provider: provider.id, error });
      }
    }

    if (searched === 0 || (failures.length > 0 && ranked.length === 0)) return { kind: "unavailable", failures };
    return { kind: "none", considered: ranked.length, failures };
  }

  private run<T>(provider: SubtitleProvider, job: () => Promise<T>): Promise<T> {
    return this.limiters.get(provider.id)!.schedule(job);
  }

  private isPaused(providerId: string): boolean {
    return (this.pausedUntil.get(providerId) ?? 0) > this.now().getTime();
  }

  private noteFailure(providerId: string, error: unknown): void {
    const now = this.now().getTime();
    if (error instanceof RateLimitedError) {
      const pauseMs = error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : (this.options.defaultPauseMs ?? 5 * 60_000);
      this.pausedUntil.set(providerId, now + pauseMs);
    } else if (error instanceof QuotaExhaustedError) {
      // Until the reset when known, else a day: quotas are daily.
      this.pausedUntil.set(providerId, error.resetsAt?.getTime() ?? now + 24 * 60 * 60_000);
    } else if (error instanceof AuthFailedError) {
      // Retrying won't help until an admin fixes the credentials; check back hourly anyway.
      this.pausedUntil.set(providerId, now + 60 * 60_000);
    }
  }
}
