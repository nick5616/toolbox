import { useState } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "@/components";
import { PostsService, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useUI } from "@/state/ui";
import { PostChoice } from "./dialogs";
import { Modal } from "./Modal";
import { NEW_POST, useAddToPost } from "./store";

export interface AddToPostDialogProps {
  path: string;
  posts: ProjectInfo[];
  onClose: () => void;
}

/** Library → Send to → Add to post…: pick a post (or a new one), then hand the file to Post Builder. */
export function AddToPostDialog({ path, posts, onClose }: AddToPostDialogProps) {
  const [choice, setChoice] = useState(posts[0]?.id ?? NEW_POST);
  const add = () => {
    useAddToPost.getState().setTarget(choice);
    useUI.getState().handOff({ moduleId: "post-builder", inputs: [path] });
    onClose();
  };
  return (
    <Modal title="Add to post" confirmLabel="Add" onConfirm={add} onClose={onClose}>
      <PostChoice posts={posts} value={choice} onChange={setChoice} />
    </Modal>
  );
}

/**
 * Opens the dialog from anywhere (the Library's Send to menu). It mounts its own
 * React root so no host view has to render it.
 */
export async function openAddToPostDialog(path: string): Promise<void> {
  let posts: ProjectInfo[] = [];
  try {
    posts = (await PostsService.List()) ?? [];
  } catch (e) {
    toast({ tone: "danger", title: toAppError(e).message });
    return;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    // Not while React is still handling the click that closed it.
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  };
  root.render(<AddToPostDialog path={path} posts={posts} onClose={close} />);
}
