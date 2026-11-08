/** Source editor/components/media/media-editor-modal settings conversion. */
export function nativeAspectRatioPresets(defaultRatios: unknown, themeRatios: unknown, showDefaultRatios: unknown) {
  const hasSettings = Array.isArray(defaultRatios) || Array.isArray(themeRatios) || typeof showDefaultRatios === "boolean";
  if (!hasSettings) return undefined;
  const candidates = [
    ...(showDefaultRatios && Array.isArray(defaultRatios) ? defaultRatios : []),
    ...(Array.isArray(themeRatios) ? themeRatios : []),
  ];
  const presets = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const { name, ratio } = candidate;
    if (ratio === undefined || ratio === null) return [];
    const [a, b, ...rest] = String(ratio).split("/").map(Number);
    if (a <= 0 || b <= 0 || Number.isNaN(a) || Number.isNaN(b) || rest.length) return [];
    const value = b ? a / b : a;
    return name && Number.isFinite(value) && value > 0 ? [{ label: name, value }] : [];
  });
  return presets.length || showDefaultRatios === false ? presets : undefined;
}
