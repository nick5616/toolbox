// Public surface of the perception tools (P6). types.ts is the frozen contract.

export * from "./types";
export { createPerceptionQueue, CancelledError, MAX_GROUPS, maskToGray, type PerceptionQueueImpl, type SubmitOptions, type SubmitRequest } from "./queue";
export { PERCEPTION_TOOLS, perceptionTool, defaultParams } from "./tools";
export { useAIStatus, warmOnce, mapGates, summarizeGates, type ToolGate, type GateMap, type GateSummary, type AIStatusState } from "./gates";
export {
  runFillTool,
  runEnhanceBrush,
  selectSubject,
  cutSubjectToNewLayer,
  createStampTips,
  createObjectSelector,
  extendCanvasWithFill,
  upscaleCanvas,
  enhanceImage,
  type StampTip,
  type StampTips,
  type ObjectSelector,
  type ObjectPoint,
} from "./ops";
export { planCrop, cropRectFor, planTiles, tileWeights } from "./crops";
export { buildFill, ringMask, extendBands, type Margins } from "./masks";
