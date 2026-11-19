/**
 * Rail ▸ Vibe and Read the picture (Phase 21 SPEC §E1). Both need Local Chat's
 * model (Read needs a vision model); without it the DepsGate names what's
 * missing and everything else in the tool keeps working. They submit nothing
 * but service calls, so they only run in the window that hosts the store.
 */
import { Banner, Button, Icon, Spinner, TextArea } from "@/components";
import { DepsGate, useDepsGate } from "../_kit/DepsGate";
import type { GradeRecipe } from "@/grade/types";
import { cancelAi, readPicture, saveLook, writeLooks } from "./actions";
import { recipeSummary } from "./recipe";
import { useGrade } from "./store";
import styles from "./Grade.module.css";

const CHAT = "llm-chat";

function LookCard({ recipe, why, onApply, onSave }: { recipe: GradeRecipe; why?: string; onApply: () => void; onSave?: () => void }) {
  return (
    <li className={styles.aiCard}>
      <button type="button" className={styles.aiApply} data-tip={`Use “${recipe.name}” on the picture`} onClick={onApply}>
        <span className={styles.aiName}>
          <span aria-hidden>✦</span> {recipe.name}
        </span>
        <span className={styles.aiWhy}>{why ?? recipeSummary(recipe)}</span>
      </button>
      {onSave && (
        <Button size="sm" variant="ghost" icon="bookmark-plus" data-tip="Keep this look in Mine" onClick={onSave}>
          Save
        </Button>
      )}
    </li>
  );
}

export function VibePanel() {
  const gate = useDepsGate(CHAT);
  const text = useGrade((s) => s.vibeText);
  const setText = useGrade((s) => s.setVibeText);
  const vibe = useGrade((s) => s.vibe);
  const current = useGrade((s) => s.recipe);
  const busy = vibe.phase === "busy";
  const blocked = gate.blocked;
  const empty = text.trim() === "";
  const why = blocked ? gate.reason : empty ? "Describe the look first" : "";
  return (
    <div className={styles.panel}>
      <DepsGate moduleId={CHAT} />
      <TextArea
        value={text}
        minRows={3}
        maxLength={300}
        placeholder="haunted vaporwave mall at 3 am"
        aria-label="Describe the look"
        data-tip="Say what you want in your own words, up to 300 characters"
        onChange={(e) => setText(e.target.value)}
      />
      <div className={styles.actions}>
        {busy ? (
          <>
            <span className={styles.busy} role="status">
              <Spinner /> Writing a look…
            </span>
            <Button size="sm" variant="secondary" data-tip="Stop waiting for the model" onClick={cancelAi}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              icon="wand-sparkles"
              aria-disabled={!!why || undefined}
              data-tip={why || "Ask the local chat model to write a look from this description"}
              onClick={() => !why && void writeLooks(text, 1)}
            >
              Write a look
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="copy"
              aria-disabled={!!why || undefined}
              data-tip={why || "Ask for 3 more looks in the same spirit"}
              onClick={() => !why && void writeLooks(text, 3, 1)}
            >
              More like this
            </Button>
          </>
        )}
      </div>
      {vibe.phase === "error" && (
        <Banner tone="danger" title="The chat model couldn't write a look">
          {vibe.error || "Try again or rephrase."}
        </Banner>
      )}
      {vibe.results.length > 0 && (
        <ul className={styles.aiList} aria-label="Looks the model wrote">
          {vibe.results.map((r, i) => (
            <LookCard key={`${r.name}:${i}`} recipe={r} onApply={() => useGrade.getState().setRecipe(r, "")} onSave={() => void saveLook(r)} />
          ))}
        </ul>
      )}
      {vibe.results.length === 0 && vibe.phase === "idle" && <p className={styles.note}>The current look is “{current.name}”. A look takes a few seconds to write; it appears here and in the Look panel.</p>}
    </div>
  );
}

export function ReadPanel() {
  const gate = useDepsGate(CHAT);
  const read = useGrade((s) => s.read);
  const suggestions = useGrade((s) => s.suggestions);
  const selected = useGrade((s) => s.selected);
  const busy = read.phase === "busy";
  const why = gate.blocked ? gate.reason : !selected ? "Open a picture first" : "";
  return (
    <div className={styles.panel}>
      <DepsGate moduleId={CHAT} />
      <p className={styles.note}>The vision model looks at this picture (the current frame of a video) and suggests 6 looks that fit it. Nothing leaves your computer.</p>
      <div className={styles.actions}>
        {busy ? (
          <>
            <span className={styles.busy} role="status">
              <Spinner /> Looking at the picture…
            </span>
            <Button size="sm" variant="secondary" data-tip="Stop waiting for the model" onClick={cancelAi}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon="scan-eye"
            aria-disabled={!!why || undefined}
            data-tip={why || "Ask the vision model for 6 looks that suit this picture"}
            onClick={() => !why && void readPicture()}
          >
            Read the picture
          </Button>
        )}
      </div>
      {read.phase === "error" && (
        <Banner tone="danger" title="Couldn't read the picture">
          {read.error}
        </Banner>
      )}
      {suggestions.length > 0 && (
        <>
          <ul className={styles.aiList} aria-label="Looks for this picture">
            {suggestions.map((s) => (
              <LookCard key={s.name} recipe={s.recipe} why={s.why} onApply={() => useGrade.getState().setRecipe(s.recipe, "")} onSave={() => void saveLook(s.recipe)} />
            ))}
          </ul>
          <p className={styles.note}>
            <Icon name="sparkles" size={12} /> They're also in the gallery under “✦ For this picture”.
          </p>
        </>
      )}
    </div>
  );
}
