// Imports every step-editor group so they register (SPEC.md §11.4).
import "./media";
import "./compound";
import "./docs";
import "./documents";
import "./builtin";
import "./phase14";
import "./phase14media";
import "./scenes";
import "./gif";
import "./organize";
import "./lanshare";
import "./silence";
import "./compress";
import "./imagebatch";
import "./focus";
import "./wait";
import "./open";
import { registerSteps as registerTts } from "./registry";
import { ttsSteps } from "./tts";

registerTts(ttsSteps);

export { registeredStepTypes, registerSteps, stepUI, parseObject, type StepEditorProps, type StepUI } from "./registry";
