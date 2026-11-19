import { currentWindow } from "@/lib/windows";

/** True in a part window of this tool: a replica never saves, submits jobs or renders gallery thumbnails. */
export function isGradeReplica(): boolean {
  const w = currentWindow();
  return w.kind === "part" && w.part.startsWith("grade.");
}

export function useReplicaFlag(): boolean {
  return isGradeReplica();
}
