import { Banner, Button } from "@/components";
import { isActive, useJobs } from "@/state/jobs";
import { isOk, useDeps } from "@/state/deps";
import styles from "./DepsBanner.module.css";

export const REQUIRED_DEPS = ["yt-dlp", "ffmpeg", "ffprobe"] as const;

/** Reason submit is blocked, or null. Treats a not-yet-loaded deps list as fine. */
export function useDepsBlockReason(): string | null {
  const byId = useDeps((s) => s.byId);
  const loaded = useDeps((s) => s.list.length > 0);
  if (!loaded) return null;
  if (!isOk(byId["yt-dlp"])) return "yt-dlp isn't installed";
  if (!isOk(byId["ffmpeg"]) || !isOk(byId["ffprobe"])) return "ffmpeg is required for conversion and merging";
  return null;
}

function Hint({ text }: { text: string }) {
  return text ? <code className={styles.hint}>{text}</code> : null;
}

export function DepsBanner() {
  const byId = useDeps((s) => s.byId);
  const loaded = useDeps((s) => s.list.length > 0);
  const updateYtDlp = useDeps((s) => s.updateYtDlp);
  const installing = useJobs((s) => Object.values(s.byId).some((j) => j.moduleId === "system-ytdlp-update" && isActive(j)));
  if (!loaded) return null;

  const ytdlp = byId["yt-dlp"];
  const ffmpeg = byId["ffmpeg"];
  const ffprobe = byId["ffprobe"];
  const ffBad = !isOk(ffmpeg) || !isOk(ffprobe);
  const ffHint = (!isOk(ffmpeg) ? ffmpeg : ffprobe)?.installHint ?? "";
  const noJs = !isOk(byId["deno"]) && !isOk(byId["node"]);

  return (
    <div className={styles.root}>
      {!isOk(ytdlp) && (
        <Banner
          tone="danger"
          title="yt-dlp isn't installed"
          action={
            <Button variant="primary" size="sm" loading={installing} onClick={() => void updateYtDlp().catch(() => undefined)}>
              Install yt-dlp
            </Button>
          }
        >
          Toolbox can download and manage it for you.
        </Banner>
      )}
      {ffBad && (
        <Banner tone="warn" title="ffmpeg is required for conversion and merging">
          <Hint text={ffHint} />
        </Banner>
      )}
      {noJs && (
        <Banner tone="info" title="YouTube works best with Deno installed">
          <Hint text={byId["deno"]?.installHint ?? ""} />
        </Banner>
      )}
    </div>
  );
}
