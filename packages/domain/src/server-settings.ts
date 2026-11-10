/** Heights offered for the stream resolution cap, tallest first. */
export const MAX_STREAM_HEIGHTS = [2160, 1440, 1080, 720, 480] as const;
export type MaxStreamHeight = (typeof MAX_STREAM_HEIGHTS)[number];

/** Server-wide settings an admin changes on the settings page. */
export interface ServerSettings {
  /**
   * No stream is sent taller than this; a taller file is transcoded down rather than played
   * as-is. Null means no cap. Viewers' own quality choice can only go lower.
   */
  readonly maxStreamHeight: MaxStreamHeight | null;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = { maxStreamHeight: null };
