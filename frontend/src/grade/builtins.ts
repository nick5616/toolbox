/** The 40 built-in looks, in gallery order (Film, Bold, Bonkers). */
import type { BuiltInLook } from "./types";
import { BOLD_LOOKS } from "./looks/bold";
import { BONKERS_LOOKS } from "./looks/bonkers";
import { FILM_LOOKS } from "./looks/film";

export const BUILT_IN_LOOKS: readonly BuiltInLook[] = [...FILM_LOOKS, ...BOLD_LOOKS, ...BONKERS_LOOKS];

export { BOLD_LOOKS, BONKERS_LOOKS, FILM_LOOKS };

/** A built-in look by id (e.g. "teal-orange"), or undefined. */
export function builtInLook(id: string): BuiltInLook | undefined {
  return BUILT_IN_LOOKS.find((l) => l.id === id);
}
