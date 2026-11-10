import type { LibraryFolderRepository, LibraryRepository, LibraryScanResult, LibraryScanStatus, MediaAvailabilityRepository } from "@tessatv/domain";
import { scanLibrary, type MetadataProvidersByKind } from "@tessatv/library";

export interface LibraryScannerDependencies {
  readonly folders: LibraryFolderRepository;
  readonly repository: LibraryRepository;
  readonly availability: MediaAvailabilityRepository;
  readonly providers: MetadataProvidersByKind;
  readonly onError?: (error: Error) => void;
}

/**
 * Runs library scans one at a time — the 15-minute job and the "Scan now" button share it,
 * so pressing the button mid-scan joins the scan already running rather than starting a
 * second one over the same files — and remembers how the last one went for the settings page.
 */
export class LibraryScanner {
  private running: Promise<LibraryScanResult> | null = null;
  private last: LibraryScanResult | null = null;

  constructor(private readonly deps: LibraryScannerDependencies) {}

  status(): LibraryScanStatus {
    return { running: this.running !== null, lastScan: this.last };
  }

  scan(): Promise<LibraryScanResult> {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<LibraryScanResult> {
    const startedAt = new Date().toISOString();
    try {
      const summary = await scanLibrary(await this.deps.folders.list(), {
        repository: this.deps.repository,
        availability: this.deps.availability,
        providers: this.deps.providers,
      });
      this.last = {
        startedAt,
        finishedAt: new Date().toISOString(),
        moviesAdded: summary.import.movies?.created ?? 0,
        episodesAdded: summary.import.shows?.created ?? 0,
        identified: summary.import.identify?.identified.length ?? 0,
        relinked: (summary.import.movies?.relinked ?? 0) + (summary.import.shows?.relinked ?? 0),
        markedMissing: summary.markedMissing,
        restored: summary.restored,
        skippedFolders: [...summary.skippedFolders, ...(summary.import.movies?.skippedFolders ?? [])],
        error: null,
      };
    } catch (error) {
      this.deps.onError?.(error as Error);
      this.last = {
        startedAt,
        finishedAt: new Date().toISOString(),
        moviesAdded: 0,
        episodesAdded: 0,
        identified: 0,
        relinked: 0,
        markedMissing: 0,
        restored: 0,
        skippedFolders: [],
        error: (error as Error).message,
      };
    }
    return this.last;
  }
}
