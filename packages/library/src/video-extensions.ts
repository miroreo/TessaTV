export const VIDEO_EXTENSIONS = new Set(["mkv", "mp4", "avi", "m4v", "mov", "wmv"]);

export function isVideoFile(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension !== undefined && VIDEO_EXTENSIONS.has(extension);
}

export function fileExtension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}
