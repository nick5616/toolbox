/**
 * VizLab end-to-end mode (`TOOLBOX_VIZLAB_ARGS=e2e=<file>[&preset=<id>][&words=detect][&engine=1][&overlay=<video>]`):
 * runs the real pipeline inside the app — the engine analysis, a render
 * through the webview worker and the Go broker, the FFmpeg mux — and writes
 * the timings to e2e.json. Architect's Wave 4 check (SPEC.md §13).
 */
import { DepsService, JobsService, JobStatus, VisualizerAction, VisualizerMode, VisualizerService, WordsSource, type VisualizerOptions } from "@/lib/api";
import { PRESETS, presetById, showFromPreset } from "../presets";

type Report = Record<string, unknown>;

async function waitJob(id: string, onTick?: (msg: string) => void): Promise<{ status: string; ms: number; result: string; error: string }> {
  const t0 = Date.now();
  for (;;) {
    const j = await JobsService.Get(id);
    onTick?.(`${j.title || id}: ${j.status} ${Math.round((j.progress ?? 0) * 100)}% ${j.message ?? ""}`);
    if (j.status === JobStatus.JobDone || j.status === JobStatus.JobFailed || j.status === JobStatus.JobCancelled) {
      const err = j.error ? `${j.error}${j.errorHint ? ` — ${j.errorHint}` : ""}` : "";
      return { status: j.status, ms: j.finishedAt && j.startedAt ? j.finishedAt - j.startedAt : Date.now() - t0, result: j.resultJson ?? "", error: err };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function runE2E(q: URLSearchParams, say: (s: string) => void, report: (name: string, v: unknown) => void): Promise<void> {
  const file = q.get("e2e") ?? "";
  const out: Report = { file, startedAt: new Date().toISOString() };
  try {
    if (q.get("engine") === "1") {
      say("updating the AI engine…");
      const j = await DepsService.InstallAudioEngine();
      out.engine = await waitJob(j.id, say);
    }
    const defaults = await VisualizerService.Defaults();
    const words = (q.get("words") ?? "detect") as WordsSource;
    const analyzeOpts: VisualizerOptions = { ...defaults, action: VisualizerAction.ActionAnalyze, analyze: { ...defaults.analyze, stems: q.get("stems") !== "0", words, mood: true } };
    say("analyzing…");
    const [aj] = (await VisualizerService.Enqueue([file], analyzeOpts)) ?? [];
    if (!aj) throw new Error("analyze not queued");
    const analyzed = await waitJob(aj.id, say);
    out.analyze = { status: analyzed.status, ms: analyzed.ms, error: analyzed.error };
    const ref = (JSON.parse(analyzed.result || "{}") as { analysis?: { key: string; summary: unknown } }).analysis;
    if (!ref) throw new Error(`analysis failed: ${analyzed.error}`);
    out.summary = ref.summary;
    const presetIds = (q.get("preset") ?? "spectrum-classic").split(",");
    const renders: Report[] = [];
    for (const id of presetIds) {
      const p = presetById(id) ?? PRESETS[0];
      if (!p) continue;
      for (const height of (q.get("heights") ?? "1080").split(",").map(Number)) {
        say(`rendering ${p.id} at ${height}p…`);
        const opts: VisualizerOptions = {
          ...defaults,
          action: VisualizerAction.ActionRender,
          analysisKey: ref.key,
          showJson: JSON.stringify(showFromPreset(p)),
          mode: VisualizerMode.ModeFull,
          aspect: "16:9",
          height,
          fps: 30,
        };
        const [rj] = (await VisualizerService.Enqueue([file], opts)) ?? [];
        if (!rj) throw new Error("render not queued");
        const r = await waitJob(rj.id, say);
        renders.push({ preset: p.id, height, status: r.status, ms: r.ms, error: r.error, result: r.result ? JSON.parse(r.result) : null });
      }
    }
    out.renders = renders;
    const video = q.get("overlay");
    if (video) {
      say("analyzing the video…");
      const [vj] = (await VisualizerService.Enqueue([video], { ...analyzeOpts, analyze: { ...analyzeOpts.analyze, stems: false } })) ?? [];
      const va = vj ? await waitJob(vj.id, say) : null;
      const vref = va ? (JSON.parse(va.result || "{}") as { analysis?: { key: string } }).analysis : undefined;
      if (vref) {
        const p = presetById("clean-captions") ?? presetById("frame-pulse") ?? PRESETS[0];
        say("rendering over the video…");
        const [oj] = (await VisualizerService.Enqueue([video], { ...defaults, action: VisualizerAction.ActionRender, analysisKey: vref.key, showJson: JSON.stringify(showFromPreset(p!)), mode: VisualizerMode.ModeOverlay })) ?? [];
        const o = oj ? await waitJob(oj.id, say) : null;
        out.overlay = o ? { preset: p?.id, status: o.status, ms: o.ms, error: o.error, result: o.result ? JSON.parse(o.result) : null } : null;
      } else out.overlay = { error: va?.error ?? "not analysed" };
    }
  } catch (e) {
    out.error = String(e instanceof Error ? e.message : e);
  }
  out.finishedAt = new Date().toISOString();
  report("e2e.json", out);
  say("e2e done");
}
