import type { SubtitleRepository } from "@tessatv/domain";
import type { SubtitleAcquirer } from "./acquire.js";
import type { SubtitlePreference } from "./score.js";

export interface SubtitleSweepSummary {
  readonly downloaded: number;
  readonly embedded: number;
  readonly notFound: number;
  readonly unavailable: number;
  readonly failed: number;
}

export interface SubtitleSweepOptions {
  readonly subtitles: Pick<SubtitleRepository, "listWanting">;
  readonly acquirer: Pick<SubtitleAcquirer, "acquire">;
  /** Slots to fill, in priority order. */
  readonly preferences: readonly SubtitlePreference[];
  /** Stop starting new units after this long, so a run finishes inside the job's expiry. */
  readonly budgetMs: number;
  /** Most units per slot per run; the rest wait for the next run. Default 25. */
  readonly batchSize?: number;
  readonly allowMachineTranslated?: boolean;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, unitId: string) => void;
}

/**
 * Fills whatever subtitle slots are still empty, newest imports first, within a time budget.
 * A run does a bounded amount of work: units that missed are held back by their retry time, so
 * a big library catches up over several runs, then only new imports need work. Stops early
 * once every provider is out (a unit comes back `unavailable`), rather than hammering them.
 */
export async function sweepSubtitles(options: SubtitleSweepOptions): Promise<SubtitleSweepSummary> {
  const now = options.now ?? (() => new Date());
  const started = now().getTime();
  const summary = { downloaded: 0, embedded: 0, notFound: 0, unavailable: 0, failed: 0 };

  for (const preference of options.preferences) {
    const wanted = await options.subtitles.listWanting(preference, now(), options.batchSize ?? 25);
    for (const unit of wanted) {
      if (now().getTime() - started >= options.budgetMs) return summary;
      try {
        const result = await options.acquirer.acquire(unit, preference, {
          ...(options.allowMachineTranslated ? { allowMachineTranslated: true } : {}),
        });
        if (result.kind === "downloaded") summary.downloaded++;
        else if (result.kind === "embedded") summary.embedded++;
        else if (result.kind === "none") summary.notFound++;
        else {
          summary.unavailable++;
          return summary;
        }
      } catch (error) {
        summary.failed++;
        options.onError?.(error, unit.unitId);
      }
    }
  }
  return summary;
}
