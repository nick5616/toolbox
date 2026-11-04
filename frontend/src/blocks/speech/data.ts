import { useEffect, useState } from "react";
import { TranscribeService, type Language, type PresetInfo } from "@/lib/api";

/** The spoken languages the speech engine knows; [] when it can't be asked. */
export async function loadSpeechLanguages(): Promise<Language[]> {
  try {
    return (await TranscribeService.Languages()) ?? [];
  } catch {
    return [];
  }
}

/** The speech model presets (sizes, speed); [] when it can't be asked. */
export async function loadSpeechPresets(): Promise<PresetInfo[]> {
  try {
    return (await TranscribeService.Presets()) ?? [];
  } catch {
    return [];
  }
}

/** Languages and model presets, loaded once per mount. */
export function useSpeechData(): { languages: Language[]; presets: PresetInfo[] } {
  const [languages, setLanguages] = useState<Language[]>([]);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadSpeechPresets().then((p) => !cancelled && setPresets(p));
    void loadSpeechLanguages().then((l) => !cancelled && setLanguages(l));
    return () => {
      cancelled = true;
    };
  }, []);
  return { languages, presets };
}
