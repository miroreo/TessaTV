import type { ApiErrorResponse, UnitProgress, UnitSummary } from "@tessatv/domain";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetcher(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new ApiError(response.status, body?.message ?? body?.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** "S1:E4" for episodes, nothing for movies. */
export function episodeCode(unit: Pick<UnitSummary, "season" | "episode">): string {
  return unit.season !== null && unit.episode !== null ? `S${unit.season}:E${unit.episode}` : "";
}

export function progressFraction(progress: UnitProgress | null): number {
  if (!progress?.durationSeconds || progress.completed) return 0;
  return Math.min(1, progress.positionSeconds / progress.durationSeconds);
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
