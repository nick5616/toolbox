import { ErrorCode } from "./api";
import { currentPresenter, rewriteText } from "./pathRewrite";

/** The JSON shape of core.AppError as marshalled by api.MarshalError. */
export interface AppErrorShape {
  code: ErrorCode | string;
  message: string;
  hint?: string;
  fields?: Record<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function fromObject(v: unknown): AppErrorShape | null {
  if (!isRecord(v) || typeof v.code !== "string" || typeof v.message !== "string") return null;
  const out: AppErrorShape = { code: v.code, message: v.message };
  if (typeof v.hint === "string" && v.hint) out.hint = v.hint;
  if (isRecord(v.fields)) {
    const fields: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.fields)) if (typeof val === "string") fields[k] = val;
    out.fields = fields;
  }
  return out;
}

/**
 * Normalises anything thrown by a binding call (Wails RuntimeError with a
 * `cause`, a plain Error, a string…) into an AppErrorShape.
 */
export function toAppError(e: unknown): AppErrorShape {
  return presentError(rawAppError(e));
}

function rawAppError(e: unknown): AppErrorShape {
  if (isRecord(e)) {
    const fromCause = fromObject(e.cause);
    if (fromCause) return fromCause;
    if (typeof e.cause === "string") {
      try {
        const parsed = fromObject(JSON.parse(e.cause));
        if (parsed) return parsed;
      } catch {
        /* not JSON */
      }
    }
    const direct = fromObject(e);
    if (direct) return direct;
    if (typeof e.message === "string") return { code: ErrorCode.CodeInternal, message: e.message };
  }
  return { code: ErrorCode.CodeInternal, message: String(e) };
}

/**
 * With "Hide personal details" on, the root and home folders inside an error's message, hint
 * and field texts are rewritten (SPEC A5), so a toast never shows the user name.
 */
function presentError(err: AppErrorShape): AppErrorShape {
  const pr = currentPresenter();
  if (!pr.on) return err;
  const out: AppErrorShape = { ...err, message: rewriteText(err.message, pr) };
  if (err.hint) out.hint = rewriteText(err.hint, pr);
  if (err.fields) out.fields = Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, rewriteText(v, pr)]));
  return out;
}
