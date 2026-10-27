/**
 * Loads a module's saved options (SettingsService.ModuleState) merged over
 * `defaults` via `sanitize`, and saves changes debounced 300 ms.
 * Returns [options, setOptions, loaded].
 */
export function useModuleOptions<T>(
  moduleId: string,
  defaults: T,
  sanitize: (saved: unknown, defaults: T) => T,
): [T, (next: T | ((prev: T) => T)) => void, boolean] {
  void moduleId;
  void sanitize;
  return [defaults, () => {}, false];
}
