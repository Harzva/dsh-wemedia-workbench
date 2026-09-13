import type { LibraryDetail, LibraryListInput, LibraryMediaChunk, LibraryMediaInput, LibraryPage } from "../domain/contentLibrary.ts";

export interface ContentLibrary {
  list(input: LibraryListInput, signal?: AbortSignal): Promise<LibraryPage>;
  read(itemId: string, signal?: AbortSignal): Promise<LibraryDetail>;
  media(input: LibraryMediaInput, signal?: AbortSignal): Promise<LibraryMediaChunk>;
}
