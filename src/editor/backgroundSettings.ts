/** Expand the source appearanceTools background opt-ins, respecting disables. */
export function editorBackgroundSettings(settings: { appearanceTools?: boolean; background?: Record<string, unknown> } = {}) {
  return {
    ...(settings.appearanceTools ? { backgroundImage: true, backgroundSize: true, gradient: true } : {}),
    ...settings.background,
  };
}
