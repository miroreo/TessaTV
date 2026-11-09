import type { Jsonified, LibraryNodesResponse } from "@tessatv/domain";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ fetch }) => {
  const response = await fetch("/api/library");
  const body = (await response.json()) as Jsonified<LibraryNodesResponse>;
  return { items: body.items };
};
