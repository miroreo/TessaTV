import type { LibraryFolder } from "../library-folder.js";

export interface LibraryFolderRepository {
  list(): Promise<LibraryFolder[]>;
  /** Throws if a folder with the same path already exists. */
  add(folder: LibraryFolder): Promise<void>;
  remove(id: string): Promise<void>;
}
