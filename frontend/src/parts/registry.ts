import type { PartSpec } from "./types";

const parts = new Map<string, PartSpec>();

/** Registers a part (idempotent per id: the last definition wins). Returns the spec. */
export function definePart(spec: PartSpec): PartSpec {
  parts.set(spec.id, spec);
  return spec;
}

export function getPart(id: string): PartSpec | undefined {
  return parts.get(id);
}

export function listParts(): PartSpec[] {
  return [...parts.values()];
}
