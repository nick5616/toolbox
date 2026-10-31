import { useCallback, useMemo, useState, type ReactNode } from "react";
import { TemplateGallery } from "./TemplateGallery";

/** Returns the template gallery dialog element to render and a function that opens it (SPEC.md §11.2). */
export function useNewPipeline(): { open: () => void; dialog: ReactNode } {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const dialog = useMemo(() => <TemplateGallery open={isOpen} onClose={() => setOpen(false)} />, [isOpen]);
  return { open, dialog };
}
