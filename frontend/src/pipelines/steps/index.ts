// Imports every step-editor group so they register (SPEC.md §11.4).
import "./media";
import "./compound";
import "./docs";
import "./builtin";

export { registeredStepTypes, registerSteps, stepUI, parseObject, type StepEditorProps, type StepUI } from "./registry";
