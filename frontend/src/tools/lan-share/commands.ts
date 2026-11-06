import { toast } from "@/components/toast";
import { LanReceiveMode, LanShareService } from "@/lib/api";
import type { Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { useLanShare } from "@/state/lanshare";
import { useUI } from "@/state/ui";
import { MODULE_ID } from "./constants";

function setReceive(mode: LanReceiveMode): () => Promise<void> {
  return async () => {
    try {
      await LanShareService.SetReceive(mode);
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
  };
}

/** Palette commands of Local File Transfer (SPEC §6.2). */
export function lanshareCommands(): Command[] {
  const keywords = ["send", "share", "transfer", "airdrop", "localsend", "phone", "wifi"];
  return [
    {
      id: "lanshare.start",
      title: "Start receiving files",
      section: "Actions",
      icon: "arrow-left-right",
      keywords,
      enabled: () => !useLanShare.getState().state.listening,
      run: setReceive(LanReceiveMode.ReceiveAlways),
    },
    {
      id: "lanshare.stop",
      title: "Stop receiving files",
      section: "Actions",
      icon: "arrow-left-right",
      keywords,
      enabled: () => useLanShare.getState().state.mode !== LanReceiveMode.ReceiveOff && useLanShare.getState().state.mode !== LanReceiveMode.$zero,
      run: setReceive(LanReceiveMode.ReceiveOff),
    },
    {
      id: "lanshare.send",
      title: "Send files to a device…",
      section: "Actions",
      icon: "send",
      keywords,
      run: () => {
        useLanShare.getState().requestSend();
        useUI.getState().navigate(MODULE_ID);
      },
    },
  ];
}
