// Heroicons (24px solid), straight from the official `heroicons` package's SVG files —
// there's no official Svelte build, and its raw SVGs need no wrapper library.
import adjustments from "heroicons/24/solid/adjustments-horizontal.svg?raw";
import arrowLeft from "heroicons/24/solid/arrow-left.svg?raw";
import back from "heroicons/24/solid/arrow-uturn-left.svg?raw";
import ahead from "heroicons/24/solid/arrow-uturn-right.svg?raw";
import exitFullscreen from "heroicons/24/solid/arrows-pointing-in.svg?raw";
import fullscreen from "heroicons/24/solid/arrows-pointing-out.svg?raw";
import subtitles from "heroicons/24/solid/chat-bubble-bottom-center-text.svg?raw";
import check from "heroicons/24/solid/check-circle.svg?raw";
import next from "heroicons/24/solid/forward.svg?raw";
import pause from "heroicons/24/solid/pause.svg?raw";
import play from "heroicons/24/solid/play.svg?raw";
import volume from "heroicons/24/solid/speaker-wave.svg?raw";
import muted from "heroicons/24/solid/speaker-x-mark.svg?raw";

export const icons = {
  adjustments,
  arrowLeft,
  back,
  ahead,
  exitFullscreen,
  fullscreen,
  subtitles,
  check,
  next,
  pause,
  play,
  volume,
  muted,
} as const;

export type IconName = keyof typeof icons;
