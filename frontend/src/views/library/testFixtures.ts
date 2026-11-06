/** Fixtures and service mocks shared by the Library tests (vitest only). */
import {
  LibrarySort,
  OutputKind,
  ProjectKind,
  type LibraryEntry,
  type LibraryFolder,
  type Output,
  type OutputDetail,
} from "@/lib/api";
import { DEFAULT_FILTERS, useLibrary } from "@/state/library";
import { svc } from "./testSvc";

export { svc };

export function out(id: string, over: Partial<Output> = {}): Output {
  return {
    id,
    jobId: "j",
    moduleId: "downloader",
    path: `/lib/${id}.mp3`,
    name: `${id}.mp3`,
    kind: OutputKind.KindAudio,
    sizeBytes: 2048,
    createdAt: Date.now() - 1000,
    missing: false,
    tags: [],
    ...over,
  } as Output;
}

export function img(id: string, over: Partial<Output> = {}): Output {
  return out(id, { path: `/lib/${id}.png`, name: `${id}.png`, kind: OutputKind.KindImage, moduleId: "object-eraser", ...over });
}

export function detail(output: Output, over: Partial<OutputDetail> = {}): OutputDetail {
  return {
    output,
    jobTitle: "",
    options: "",
    summary: "",
    madeFrom: [],
    madeInto: [],
    chain: [],
    chainAt: 0,
    width: 0,
    height: 0,
    unknown: false,
    ...over,
  };
}

export function entry(name: string, over: Partial<LibraryEntry> = {}): LibraryEntry {
  return { name, path: `/lib/Erased/${name}`, rel: `Erased/${name}`, isDir: false, sizeBytes: 100, modTime: Date.now(), kind: OutputKind.KindImage, output: null, ...over };
}

export function folder(name: string, files: number, children: LibraryFolder[] = [], over: Partial<LibraryFolder> = {}): LibraryFolder {
  return { rel: name === "Toolbox" ? "" : name, name, path: `/lib/${name === "Toolbox" ? "" : name}`, files, registered: 0, newestMod: 0, moduleIds: [], children, ...over };
}

export const notImplemented = () => Object.assign(new Error("not implemented"), { cause: { code: "not_implemented", message: "not implemented" } });

export function resetMocks(): void {
  for (const f of Object.values(svc)) f.mockReset();
  svc.Query.mockResolvedValue({ items: [], nextCursor: "" });
  svc.Recent.mockResolvedValue({ items: [], nextCursor: "" });
  svc.Folders.mockResolvedValue(folder("Toolbox", 0));
  svc.ListDir.mockResolvedValue({ entries: [], truncated: false });
  svc.Detail.mockImplementation((idOrPath: string) => Promise.resolve(detail(out(idOrPath))));
  svc.Places.mockResolvedValue({ projects: [], savedMasks: [] });
  svc.TrashAvailable.mockResolvedValue(true);
  svc.Trash.mockResolvedValue({ trashed: [], failed: null });
  svc.SaveCopies.mockResolvedValue("/dest");
  for (const k of ["Reveal", "RevealPath", "Open", "Remove", "OpenLibraryFolder"] as const) svc[k].mockResolvedValue(undefined);
  svc.SaveCopy.mockResolvedValue("");
  svc.ImageThumb.mockResolvedValue("data:image/jpeg;base64,AAAA");
  svc.ReadText.mockResolvedValue("line one\nline two");
  svc.Filmstrip.mockResolvedValue("/media/t/strip.jpg");
  svc.Waveform.mockResolvedValue([0.1, 0.5, 0.9, 0.3]);
  svc.Thumbnail.mockResolvedValue("data:image/jpeg;base64,BBBB");
  svc.PdfInfo.mockResolvedValue({ pages: 3 });
  svc.Match.mockResolvedValue({ matches: [], unmatched: null });
  useLibrary.setState({
    view: "grid",
    size: "m",
    filters: { ...DEFAULT_FILTERS, sort: LibrarySort.SortNewest },
    folder: "",
    items: [],
    list: [],
    listNext: "",
    listLoading: false,
    unavailable: false,
    target: null,
    folders: null,
    foldersUnavailable: false,
    places: null,
    placesUnavailable: false,
  });
}

export const project = { id: "p1", kind: ProjectKind.ProjectPaint, moduleId: "paint", name: "Sunset", thumb: "", render: "", updatedAt: Date.now() };
