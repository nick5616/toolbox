import { useQueueVersion, useEditor } from "../context";
import { IconButton, Island } from "../ui";
import ed from "../editor.module.css";
import styles from "./panels.module.css";

/**
 * The floating Generations strip (SPEC §1.4.2): the original, then pass 1…N,
 * plus re-rolls, for the newest operation. Click one to swap it in. Also
 * shown inside the Lab strip when `inline`.
 */
export function GenerationsStrip({ inline }: { inline?: boolean }) {
  const { queue } = useEditor();
  useQueueVersion(queue);
  const group = queue.groups()[0];
  if (!group) return null;
  const drift0 = group.generations.length > 0 && group.seed === 0;
  return (
    <Island label="Generations" className={inline ? ed.gensInline : ed.gens}>
      <div className={styles.gens} role="group" aria-label={`Generations of ${group.toolId}`} data-testid="generations">
        {group.generations.map((g, i) => (
          <button key={g.id} type="button" className={styles.gen} aria-pressed={i === group.current} data-tip={`Put “${g.label}” on the canvas`} onClick={() => queue.choose(group.id, i)}>
            {g.thumb ? <img src={g.thumb} alt="" /> : null}
            <span>{g.label}</span>
          </button>
        ))}
      </div>
      <IconButton
        icon="dice"
        label="Re-roll"
        onClick={() => void queue.reroll(group.id).catch(() => undefined)}
      />
      {drift0 ? <span className={ed.hint}>Drift is 0, so a re-roll gives the same result</span> : null}
    </Island>
  );
}
