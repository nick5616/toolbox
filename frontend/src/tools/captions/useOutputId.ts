import { useEffect, useState } from "react";
import { LibraryService } from "@/lib/api";

/** The library output id of a file Toolbox wrote ("" when it isn't registered or unknown), so Open works on it. */
export function useOutputId(path: string): string {
  const [id, setId] = useState("");
  useEffect(() => {
    setId("");
    if (path === "") return;
    let live = true;
    LibraryService.Detail(path)
      .then((d) => live && setId(d?.output?.id ?? ""))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [path]);
  return id;
}
