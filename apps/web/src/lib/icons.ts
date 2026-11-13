// Heroicons (24px solid), straight from the official `heroicons` package's SVG files —
// there's no official Svelte build, and its raw SVGs need no wrapper library.
import adjustments from "heroicons/24/solid/adjustments-horizontal.svg?raw";
import rescan from "heroicons/24/solid/arrow-path.svg?raw";
import stats from "heroicons/24/solid/chart-bar.svg?raw";
import close from "heroicons/24/solid/x-mark.svg?raw";
import menu from "heroicons/24/solid/ellipsis-vertical.svg?raw";
import markWatched from "heroicons/24/solid/eye.svg?raw";
import markUnwatched from "heroicons/24/solid/eye-slash.svg?raw";
import restart from "heroicons/24/solid/backward.svg?raw";
import settings from "heroicons/24/solid/cog-6-tooth.svg?raw";
import warning from "heroicons/24/solid/exclamation-triangle.svg?raw";
import folder from "heroicons/24/solid/folder.svg?raw";
import add from "heroicons/24/solid/plus.svg?raw";
import remove from "heroicons/24/solid/trash.svg?raw";
import arrowLeft from "heroicons/24/solid/arrow-left.svg?raw";
import back from "heroicons/24/solid/arrow-uturn-left.svg?raw";
import ahead from "heroicons/24/solid/arrow-uturn-right.svg?raw";
import exitFullscreen from "heroicons/24/solid/arrows-pointing-in.svg?raw";
import fullscreen from "heroicons/24/solid/arrows-pointing-out.svg?raw";
import subtitles from "heroicons/24/solid/chat-bubble-bottom-center-text.svg?raw";
import search from "heroicons/24/solid/magnifying-glass.svg?raw";
import up from "heroicons/24/solid/chevron-up.svg?raw";
import down from "heroicons/24/solid/chevron-down.svg?raw";
import check from "heroicons/24/solid/check-circle.svg?raw";
import next from "heroicons/24/solid/forward.svg?raw";
import pause from "heroicons/24/solid/pause.svg?raw";
import play from "heroicons/24/solid/play.svg?raw";
import normalize from "heroicons/24/solid/scale.svg?raw";
import volume from "heroicons/24/solid/speaker-wave.svg?raw";
import muted from "heroicons/24/solid/speaker-x-mark.svg?raw";

export const icons = {
  adjustments,
  rescan,
  stats,
  close,
  menu,
  markWatched,
  markUnwatched,
  restart,
  settings,
  warning,
  folder,
  add,
  remove,
  arrowLeft,
  back,
  ahead,
  exitFullscreen,
  fullscreen,
  subtitles,
  up,
  down,
  check,
  search,
  next,
  normalize,
  pause,
  play,
  volume,
  muted,
} as const;

export type IconName = keyof typeof icons;
