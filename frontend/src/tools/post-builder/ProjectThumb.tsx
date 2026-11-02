import { useMemo } from "react";
import { cx, Icon } from "@/components";
import type { ProjectInfo } from "@/lib/api";
import { blankSlide } from "./logic";
import { useSlideVisual } from "./useSlideVisual";
import styles from "./ProjectThumb.module.css";

/** A saved project's thumbnail (square, object-fit cover) or a tile when it has none. */
export function ProjectThumb({ project, className }: { project: ProjectInfo | undefined; className?: string }) {
  const slide = useMemo(() => blankSlide("composition"), []);
  const v = useSlideVisual(project?.thumb ? slide : undefined, project, 240);
  return (
    <span className={cx(styles.thumb, className)}>
      {v.url ? <img src={v.url} alt="" draggable={false} /> : <Icon name={project?.kind === "video" ? "clapperboard" : "layers"} size={20} />}
    </span>
  );
}
