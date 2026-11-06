/**
 * Dev Utilities as a workspace (Phase 11, SPEC §5.7): every utility is a panel
 * that can pop out into a small window and stay live. The main window hosts
 * the utilities store (`store.ts`); a utility window holds a replica and its
 * edits run on the host.
 */
import { Suspense, type ComponentType } from "react";
import { Spinner } from "@/components";
import { defineWorkspace, type ToolPanel } from "@/workspace";
import { UTILS, UTIL_TIPS, type UtilId } from "./registry";
import { useDevUtils, type DevUtilsStore, type DevUtilsValues } from "./store";
import styles from "./DevUtils.module.css";

export const MODULE_ID = "dev-utils";

function panelFor(id: UtilId): ComponentType {
  const info = UTILS.find((u) => u.id === id);
  if (!info) throw new Error(`unknown utility ${id}`);
  const Active = info.Component;
  function UtilPanel() {
    return (
      <div className={styles.panelBody}>
        <Suspense fallback={<Spinner />}>
          <Active />
        </Suspense>
      </div>
    );
  }
  UtilPanel.displayName = `${info.name}Panel`;
  return UtilPanel;
}

const panels: ToolPanel[] = UTILS.map((u) => ({
  id: u.id,
  title: u.name,
  icon: u.icon,
  tip: UTIL_TIPS[u.id],
  component: panelFor(u.id),
  drawerWidth: 420,
  width: 520,
  height: 560,
}));

export const devUtilsWorkspace = defineWorkspace<DevUtilsStore, DevUtilsValues>({
  moduleId: MODULE_ID,
  store: useDevUtils,
  bridge: {
    pick: (s) => ({ values: s.values }),
    apply: (store, v) => {
      if (v.values !== undefined) store.setState({ values: v.values });
    },
    actions: ["setValue"],
  },
  isOpen: () => true,
  panels,
});
