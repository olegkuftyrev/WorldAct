/** Expand the source appearanceTools background opt-ins, respecting disables. */
export function editorBackgroundSettings(settings: { appearanceTools?: boolean; background?: Record<string, unknown> } = {}) {
  return {
    ...(settings.appearanceTools ? { backgroundImage: true, backgroundSize: true, gradient: true } : {}),
    ...settings.background,
  };
}

/** Source appearanceTools also enables the native dimension controls. */
export function editorDimensionSettings(settings: { appearanceTools?: boolean; dimensions?: Record<string, unknown> } = {}) {
  return {
    ...(settings.appearanceTools ? { aspectRatio:true,height:true,minHeight:true,minWidth:true,width:true } : {}),
    ...settings.dimensions,
  };
}
