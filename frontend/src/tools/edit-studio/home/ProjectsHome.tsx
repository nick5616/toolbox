/** The projects home and New edit dialog (§14.1). Wave 0 stub (owned by WP-ES2); the props are frozen. */
export interface ProjectsHomeProps {
  moduleId: string;
  /** Opens a project (the view loads it). */
  onOpen(id: string): void;
}

export function ProjectsHome({ moduleId }: ProjectsHomeProps) {
  return <p>Edit Studio projects ({moduleId}) are coming.</p>;
}
