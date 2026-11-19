/**
 * The op catalog (Phase 21 SPEC §E3.1). G1 fills OP_DEFS with every kind's
 * params, ranges and defaults, and grade/math.ts with the reference
 * functions the GLSL mirrors. The chat model's prompt is built from the same
 * catalog (modules/grade/prompt.go mirrors the ranges; a shared-vector test
 * keeps them equal).
 */
import type { GradeOpKind, OpDef } from "./types";

export const OP_DEFS: Partial<Record<GradeOpKind, OpDef>> = {};

export function opDef(kind: GradeOpKind): OpDef | undefined {
  return OP_DEFS[kind];
}
