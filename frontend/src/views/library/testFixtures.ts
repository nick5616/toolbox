/** Fixtures and service mocks shared by the Library tests (vitest only). */
import {
  LibrarySort,
  OutputKind,
  ProjectKind,
  type LibraryEntry,
  type LibraryFolder,
  type Output,
  type OutputDetail,
  type SearchHit,
  type SearchPage,
  type SearchStatus,
} from "@/lib/api";
import { DEFAULT_FILTERS, useLibrary } from "@/state/library";
import { EMPTY_STATUS, resetSearchMemory, useSearch } from "@/state/search";
import { bus, search, svc } from "./testSvc";

export { svc, search };

/** A Smart search status: installed and up to date unless overridden. */
export function status(over: Partial<SearchStatus> = {}): SearchStatus {
  return { ...EMPTY_STATUS, installed: true, enabled: true, total: 100, done: 100, ...over };
}

/** A search hit for a library output (a concept hit by default). */
export function hit(output: Output | null, over: Partial<SearchHit> = {}): SearchHit {
  return {
    path: output?.path ?? "/lib/x.png",
    source: "library",
    projectId: "",
    output,
    kind: output?.kind ?? OutputKind.KindImage,
    score: 0.4,
    strength: "strong",
    via: ["concept"],
    pos: -1,
    snippet: "",
    moments: [],
    ...over,
  } as SearchHit;
}

export function page(hits: SearchHit[], over: Partial<SearchPage> = {}): SearchPage {
  return { hits, labels: [], concept: true, warming: false, ...over };
}

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
  for (const f of Object.values(search)) f.mockReset();
  bus.handlers.clear();
  resetSearchMemory();
  search.Status.mockResolvedValue({ ...EMPTY_STATUS });
  search.Settings.mockResolvedValue({ enabled: true, paused: false, readText: true, speech: true, speechMaxMin: 60, skip: [] });
  search.SetSettings.mockResolvedValue(undefined);
  search.Query.mockResolvedValue({ hits: [], labels: [], concept: true, warming: false });
  search.Things.mockResolvedValue([]);
  search.Labels.mockResolvedValue([]);
  search.Texts.mockResolvedValue([]);
  search.SetLabel.mockResolvedValue(undefined);
  search.SaveText.mockResolvedValue("");
  search.Failures.mockResolvedValue([]);
  for (const k of ["ReadAgain", "Retry", "Rescan", "Rebuild", "DeleteIndex", "Warm"] as const) search[k].mockResolvedValue(undefined);
  search.Frame.mockResolvedValue("/media/t/frame.jpg");
  search.PacksInstall.mockResolvedValue({ jobs: [], restart: false });
  useSearch.setState({
    status: { ...EMPTY_STATUS },
    statusLoaded: false,
    settings: null,
    labels: [],
    labelNames: {},
    similar: null,
    page: null,
    loading: false,
    answeredText: "",
    things: null,
    thingsLoading: false,
    indexedVersion: 0,
    labelCache: {},
    textCache: {},
    selectedPath: "",
    selectedPos: -1,
    focusPending: false,
  });
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
