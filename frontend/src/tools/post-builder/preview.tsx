/** The phone preview as the workspace's preview part: follows the selected slide; pictures load in this window. */
import { PhonePreview } from "./PhonePreview";
import { useDoc, usePostBuilder, useProjects } from "./postStore";

export function PhonePreviewPart() {
  const doc = useDoc();
  const selectedId = usePostBuilder((s) => s.selectedId);
  const projects = useProjects();
  if (!doc) return null;
  return <PhonePreview slides={doc.slides} aspect={doc.aspect} caption={doc.caption} projects={projects} currentId={selectedId} onCurrent={(id) => usePostBuilder.getState().select(id)} />;
}
