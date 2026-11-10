import type { TitleResponse } from "@tessatv/domain";
import { api } from "$lib/api.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ fetch, params }) => ({
  view: await api<TitleResponse>(fetch, `/api/browse/title/${params.id}`),
});
