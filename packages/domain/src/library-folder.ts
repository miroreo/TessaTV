/** A folder on disk the scheduled scan imports from. Edited on the admin settings page. */
export interface LibraryFolder {
  readonly id: string;
  /** Which scanner reads it: movie folders (`Title (Year)/file`) or show folders (`Show/…/SxxExx`). */
  readonly mediaType: "movie" | "series";
  /** Absolute path, as seen by the server process (inside the container, under Docker). */
  readonly path: string;
  readonly createdAt: Date;
}
