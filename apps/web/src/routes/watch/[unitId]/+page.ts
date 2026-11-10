import type { PlaybackInfoResponse } from "@tessatv/domain";
import { api } from "$lib/api.js";
import type { PageLoad } from "./$types.js";

// Playback depends on what this browser can decode, which only the browser knows.
export const ssr = false;

export const load: PageLoad = async ({ fetch, params }) => ({
  info: await api<PlaybackInfoResponse>(fetch, `/api/playback/${params.unitId}`),
});
