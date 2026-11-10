import type { HomeResponse } from "@tessatv/domain";
import { api } from "$lib/api.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ fetch }) => ({ home: await api<HomeResponse>(fetch, "/api/browse/home") });
