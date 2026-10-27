import { Badge, EmptyState, Icon } from "@/components";
import { useModules } from "@/state/modules";
import styles from "./ComingSoonView.module.css";

export interface ComingSoonViewProps {
  moduleId: string;
}

export function ComingSoonView({ moduleId }: ComingSoonViewProps) {
  const mod = useModules((s) => s.byId[moduleId]);
  if (!mod) return <EmptyState icon="circle-alert" title="Unknown tool" size="lg" />;
  const { extensions, urls } = mod.accepts;
  const hasAccepts = extensions.length > 0 || urls;
  return (
    <section className={styles.root} aria-label={mod.name}>
      <span className={styles.icon}>
        <Icon name={mod.icon} size={48} strokeWidth={1.5} />
      </span>
      <h1 className={styles.name}>{mod.name}</h1>
      <p className={styles.tagline}>{mod.tagline}</p>
      {mod.description ? <p className={styles.description}>{mod.description}</p> : null}
      {hasAccepts ? (
        <div className={styles.accepts}>
          <span className={styles.label}>Accepts</span>
          <div className={styles.chips}>
            {urls ? <Badge>Links</Badge> : null}
            {extensions.map((ext) => (
              <Badge key={ext} mono>
                {ext}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <p className={styles.planned}>Planned for a future phase.</p>
    </section>
  );
}
