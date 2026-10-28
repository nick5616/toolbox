import { useEffect, useMemo, useState } from "react";
import { PdfService, type PdfInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";

export interface InfoState {
  info?: PdfInfo;
  error?: string;
}

export type Infos = Record<string, InfoState>;

/** Reads PdfService.Info for each path; `password` is applied after a short debounce and never stored. */
export function usePdfInfos(paths: readonly string[], password: string): Infos {
  const key = paths.join("\n");
  const stable = useMemo(() => (key ? key.split("\n") : []), [key]);
  const [pw, setPw] = useState(password);
  const [infos, setInfos] = useState<Infos>({});

  useEffect(() => {
    if (password === pw) return;
    const t = setTimeout(() => setPw(password), 400);
    return () => clearTimeout(t);
  }, [password, pw]);

  useEffect(() => {
    let cancelled = false;
    for (const p of stable) {
      PdfService.Info(p, pw).then(
        (info) => !cancelled && setInfos((prev) => ({ ...prev, [p]: { info } })),
        (e: unknown) => !cancelled && setInfos((prev) => ({ ...prev, [p]: { error: toAppError(e).message } })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [stable, pw]);

  return infos;
}
