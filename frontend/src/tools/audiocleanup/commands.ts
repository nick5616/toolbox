import type { Command } from "@/lib/commands";
import { useUI } from "@/state/ui";

/** Palette entries for Audio Cleanup. Merged by shell/useBuiltinCommands. */
export function audiocleanupCommands(): Command[] {
  return [
    {
      id: "audiocleanup.open",
      title: "Clean up audio: remove noise, hum and fix loudness",
      section: "Actions",
      icon: "audio-waveform",
      keywords: ["denoise", "noise", "hum", "loudness", "lufs", "podcast", "normalize", "voice", "rumble"],
      run: () => useUI.getState().navigate("audio-cleanup"),
    },
  ];
}
