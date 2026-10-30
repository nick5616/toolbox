/** The 20 curated presets (SPEC.md §6.10), in the order the picker shows them. */
import { auroraCurtains } from "./auroraCurtains";
import { cleanCaptions } from "./cleanCaptions";
import { framePulse } from "./framePulse";
import { goldenHour } from "./goldenHour";
import { inkWater } from "./inkWater";
import { kaleidoBloom } from "./kaleidoBloom";
import { lyricStage } from "./lyricStage";
import { moodField } from "./moodField";
import { nebula } from "./nebula";
import { neonHighway } from "./neonHighway";
import { nightTerrain } from "./nightTerrain";
import { oscilloscopeLab } from "./oscilloscopeLab";
import { particleStorm } from "./particleStorm";
import { radialPulse } from "./radialPulse";
import { silkWaves } from "./silkWaves";
import { spectrumClassic } from "./spectrumClassic";
import { synthwave } from "./synthwave";
import { tunnelRun } from "./tunnelRun";
import type { Preset } from "./types";
import { vortexPreset } from "./vortex";
import { warpDrive } from "./warpDrive";

export const PRESETS: readonly Preset[] = [
  goldenHour,
  neonHighway,
  nebula,
  synthwave,
  spectrumClassic,
  radialPulse,
  silkWaves,
  warpDrive,
  kaleidoBloom,
  inkWater,
  particleStorm,
  auroraCurtains,
  tunnelRun,
  nightTerrain,
  oscilloscopeLab,
  vortexPreset,
  lyricStage,
  moodField,
  cleanCaptions,
  framePulse,
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export { showFromPreset } from "./types";
export type { Preset } from "./types";
