/** The mocked services shared by the Library tests. Imports nothing from the app (the `@/lib/api` mock factory loads this file). */
import { vi } from "vitest";

/** The mocked services; reset with `resetMocks()`. */
export const svc = {
  Query: vi.fn(),
  Recent: vi.fn(),
  Folders: vi.fn(),
  ListDir: vi.fn(),
  Detail: vi.fn(),
  Places: vi.fn(),
  Rename: vi.fn(),
  TrashAvailable: vi.fn(),
  Trash: vi.fn(),
  SaveCopies: vi.fn(),
  Reveal: vi.fn(),
  RevealPath: vi.fn(),
  Open: vi.fn(),
  Remove: vi.fn(),
  OpenLibraryFolder: vi.fn(),
  SaveCopy: vi.fn(),
  ImageThumb: vi.fn(),
  ReadText: vi.fn(),
  Filmstrip: vi.fn(),
  Waveform: vi.fn(),
  Thumbnail: vi.fn(),
  PdfInfo: vi.fn(),
  Match: vi.fn(),
};

/** The module overrides every Library test installs with `vi.mock("@/lib/api", libraryApiMock)`. */
type Api = Record<string, unknown> & { LibraryService: object; FilesService: object; MediaService: object; PdfService: object; ModulesService: object };

export async function libraryApiMock(orig: () => Promise<Api>) {
  const actual = await orig();
  return {
    ...actual,
    LibraryService: { ...actual.LibraryService, ...svc, Remove: svc.Remove, SaveCopy: svc.SaveCopy },
    FilesService: { ...actual.FilesService, ImageThumb: svc.ImageThumb, ReadText: svc.ReadText, Stat: vi.fn().mockResolvedValue([]) },
    MediaService: { ...actual.MediaService, Filmstrip: svc.Filmstrip, Waveform: svc.Waveform, URLFor: vi.fn().mockResolvedValue("/media/x/y.png"), Open: vi.fn().mockResolvedValue({ url: "", info: {}, proxy: false, proxyJobId: "" }) },
    PdfService: { ...actual.PdfService, Thumbnail: svc.Thumbnail, Info: svc.PdfInfo },
    ModulesService: { ...actual.ModulesService, Match: svc.Match },
  };
}

