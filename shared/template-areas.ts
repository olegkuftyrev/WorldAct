export const templatePartAreas = ["uncategorized", "header", "footer", "navigation-overlay"] as const;
export type TemplatePartArea = typeof templatePartAreas[number];

export function sourceTemplatePartArea(themeJSON: Record<string, any>, slug: string): TemplatePartArea {
  const value = Array.isArray(themeJSON.templateParts) ? themeJSON.templateParts.find((part: any) => part?.name === slug)?.area : undefined;
  return templatePartAreas.includes(value) ? value : "uncategorized";
}
