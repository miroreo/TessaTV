import type { LibraryNode } from "@tessatv/domain";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ fetch }) => {
  const response = await fetch("/api/library");
  const body = (await response.json()) as { items: LibraryNode[] };
  return { items: body.items };
};
