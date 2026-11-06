import { useEffect, useState } from "react";
import { AppPicker } from "@/blocks/app-picker";
import { Banner, Button, ConfirmDialog, IconButton, Section, TextField } from "@/components";
import { FocusService, type FocusAllowRule, type FocusProfile } from "@/lib/api";
import { appCount, mergeRules, rulePaths, studioSuggestions, STUDIO_PROFILE_NAME } from "./model";
import { RulesList } from "./RulesList";
import styles from "./ProfilesPanel.module.css";

export interface ProfilesPanelProps {
  profiles: readonly FocusProfile[];
  loaded: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onSave: (p: FocusProfile) => Promise<FocusProfile | null>;
  onDelete: (id: string) => Promise<void>;
  /** Whether the Studio suggestion may be offered (not on unsupported OSes). */
  supported: boolean;
}

function blankProfile(name: string, rules: FocusAllowRule[]): FocusProfile {
  return { id: "", name, rules, createdAt: 0, updatedAt: 0 };
}

/** Profiles list plus the rule editor of the selected one (SPEC §5.1). */
export function ProfilesPanel({ profiles, loaded, selectedId, onSelect, onSave, onDelete, supported }: ProfilesPanelProps) {
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState("");
  const [studio, setStudio] = useState<FocusAllowRule[] | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  useEffect(() => setName(selected?.name ?? ""), [selected?.id, selected?.name]);

  // First open: offer a Studio profile built from the apps found on this computer (SPEC §4.3).
  const firstOpen = loaded && supported && profiles.length === 0 && !dismissed;
  useEffect(() => {
    if (!firstOpen) {
      setStudio(null);
      return;
    }
    let live = true;
    FocusService.Apps()
      .then((apps) => {
        if (!live) return;
        const found = studioSuggestions(apps ?? []).map((a) => a.rule);
        setStudio(found.length > 0 ? found : null);
      })
      .catch(() => live && setStudio(null));
    return () => {
      live = false;
    };
  }, [firstOpen]);

  const createStudio = async () => {
    if (!studio) return;
    const saved = await onSave(blankProfile(STUDIO_PROFILE_NAME, studio));
    if (saved) onSelect(saved.id);
  };

  const create = async () => {
    const base = "New profile";
    let n = base;
    for (let i = 2; profiles.some((p) => p.name.toLowerCase() === n.toLowerCase()); i++) n = `${base} ${i}`;
    const saved = await onSave(blankProfile(n, []));
    if (saved) onSelect(saved.id);
  };

  const rename = () => {
    const next = name.trim();
    if (!selected || next === selected.name) return;
    if (next === "") {
      setName(selected.name);
      return;
    }
    void onSave({ ...selected, name: next }).then((r) => r == null && setName(selected.name));
  };

  const setRules = (rules: FocusAllowRule[]) => {
    if (selected) void onSave({ ...selected, rules });
  };

  return (
    <Section
      label="Profiles"
      action={
        <Button size="sm" variant="ghost" icon="plus" onClick={() => void create()}>
          New profile
        </Button>
      }
    >
      {studio && (
        <Banner
          title="Start with a Studio profile?"
          action={
            <span className={styles.bannerActions}>
              <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
                Not now
              </Button>
              <Button size="sm" variant="primary" onClick={() => void createStudio()}>
                Create
              </Button>
            </span>
          }
        >
          {appCount(studio.length)} found: {studio.map((r) => r.label).join(", ")}.
        </Banner>
      )}
      {profiles.length === 0 && !studio && <p className={styles.empty}>A profile is the set of apps you want to keep using while you focus.</p>}
      {profiles.length > 0 && (
        <div className={styles.layout}>
          <ul className={styles.list} aria-label="Profiles">
            {profiles.map((p) => (
              <li key={p.id}>
                <button type="button" className={styles.item} data-on={p.id === selectedId ? "" : undefined} aria-current={p.id === selectedId || undefined} onClick={() => onSelect(p.id)}>
                  <span className={styles.itemName}>{p.name}</span>
                  <span className={styles.count}>{appCount((p.rules ?? []).length)}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <div className={styles.editor}>
              <div className={styles.editorHead}>
                <TextField size="sm" aria-label="Profile name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
                <Button size="sm" variant="secondary" icon="plus" onClick={() => setPicking(true)} data-tip="Pick apps to keep allowed in this profile">
                  Add app
                </Button>
                <IconButton size="sm" variant="danger" icon="trash-2" label={`Delete ${selected.name}`} onClick={() => setConfirmDelete(true)} />
              </div>
              <RulesList rules={selected.rules ?? []} onChange={setRules} empty="No apps yet. Everything except Toolbox and Windows would be stopped." />
            </div>
          )}
        </div>
      )}
      <AppPicker
        open={picking}
        onClose={() => setPicking(false)}
        mode="rule"
        multiple
        chosen={rulePaths(selected?.rules ?? [])}
        onPickRules={(rules) => selected && setRules(mergeRules(selected.rules ?? [], rules))}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${selected?.name ?? "profile"}?`}
        body="Its list of allowed apps is removed. Sessions already running keep their own copy."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          if (selected) void onDelete(selected.id);
        }}
      />
    </Section>
  );
}
