/** Global styles compiled from the bundled, trusted WordPress theme.json files. */
export type ThemeJSON = Record<string, any>;
export interface ThemeStyleOverrides {
  backgroundColor?: string;
  textColor?: string;
  accentColor?: string;
  fontFamily?: string;
  headingFont?: string;
  contentWidth?: number;
  spacing?: number;
}
export function mergeThemeJSON(base: ThemeJSON, patch: ThemeJSON): ThemeJSON {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value))
      result[key] = mergeThemeJSON(result[key] || {}, value);
    else if (Array.isArray(value) && Array.isArray(result[key]) && value.every((item) => item && typeof item === "object" && "slug" in item) && result[key].every((item: any) => item && typeof item === "object" && "slug" in item)) {
      // A style variation is a user-origin layer in WordPress: its presets
      // override matching slugs while theme-origin fonts/presets remain usable.
      const incoming = new Map(value.map((item) => [item.slug,item]));
      result[key] = result[key].map((item:any) => incoming.get(item.slug) || item);
      const existing = new Set(result[key].map((item:any) => item.slug));
      result[key].push(...value.filter((item) => !existing.has(item.slug)));
    } else result[key] = value;
  }
  return result;
}
export function themeValue(value: unknown, document?: ThemeJSON): string {
  if (value && typeof value === "object" && "ref" in value) {
    const resolved = String((value as { ref: string }).ref)
      .split(".")
      .reduce<any>((object, key) => object?.[key], document);
    return themeValue(resolved, document);
  }
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/var:preset\|([\w-]+)\|([\w-]+)/g, "var(--wp--preset--$1--$2)")
    : "";
}
const kebab = (text: string) => text.replace(/[A-Z]/g, (s) => "-" + s.toLowerCase());
function declarations(styles: ThemeJSON, document: ThemeJSON) {
  const rules: string[] = [];
  const add = (property: string, value: unknown) => {
    const resolved = themeValue(value, document);
    if (resolved) rules.push(property + ":" + resolved);
  };
  for (const [name, property] of Object.entries({ background: "background-color", text: "color", gradient: "background-image" }))
    add(property, styles.color?.[name]);
  for (const [name, value] of Object.entries(styles.typography || {}))
    if (["fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight", "textDecoration", "textTransform", "writingMode"].includes(name)) add(kebab(name), value);
  for (const group of ["padding", "margin"])
    if (typeof styles.spacing?.[group] === "string") add(group, styles.spacing[group]);
    else for (const [side, value] of Object.entries(styles.spacing?.[group] || {})) add(group + "-" + side, value);
  for (const [name, value] of Object.entries(styles.border || {})) {
    if (["top", "right", "bottom", "left"].includes(name))
      for (const [part, child] of Object.entries(value as ThemeJSON)) add("border-" + name + "-" + part, child);
    else if (name === "radius" && value && typeof value === "object" && !("ref" in value))
      for (const [corner, child] of Object.entries(value as ThemeJSON)) add("border-" + kebab(corner) + "-radius", child);
    else add("border-" + (name === "radius" ? "radius" : name), value);
  }
  for (const [name, value] of Object.entries(styles.outline || {})) add("outline-" + name, value);
  for (const [name, value] of Object.entries(styles.dimensions || {})) add(kebab(name), value);
  if (styles.shadow) add("box-shadow", styles.shadow);
  if (styles.spacing?.blockGap) add("--wp--style--block-gap", styles.spacing.blockGap);
  return rules.join(";");
}
const elementSelectors: Record<string, string[]> = {
  link: ["a:where(:not(.wp-element-button))"],
  button: [".wp-element-button", ".wp-block-button__link", ".wp-block-search__button", "input[type=submit]"],
  heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
  caption: [".wp-element-caption", "figcaption"],
};
function ruleTree(styles: ThemeJSON, selector: string, document: ThemeJSON, output: string[]) {
  const properties = declarations(styles, document);
  if (properties) output.push(selector + "{" + properties + "}");
  for (const [name, value] of Object.entries(styles)) {
    if (name.startsWith(":")) ruleTree(value, selector.split(",").map((s) => s + name).join(","), document, output);
  }
  for (const [name, value] of Object.entries(styles.elements || {})) {
    const children = elementSelectors[name] || [name];
    const combined = selector.split(",").flatMap((s) => children.map((child) => s + " " + child)).join(",");
    ruleTree(value as ThemeJSON, combined, document, output);
  }
  if (styles.css) {
    // Theme custom CSS is trusted bundled source. Scope each top-level rule.
    const css = String(styles.css).replace(/([^{}]+)\{([^{}]*)\}/g, (_match, selectors, body) =>
      String(selectors).split(",").map((s) => s.includes("&") ? s.trim().replace(/&/g, selector) : selector + " " + s.trim()).join(",") + "{" + body + "}");
    output.push(css);
  }
}
function fluidSize(preset: ThemeJSON) {
  if (!preset.fluid || typeof preset.fluid !== "object") return preset.size;
  const minimum = preset.fluid.min, maximum = preset.fluid.max;
  const min = Number.parseFloat(minimum), max = Number.parseFloat(maximum);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return preset.size;
  const unit = String(maximum).replace(/[\d.\s]/g, "");
  if (!["rem", "px", "em"].includes(unit) || !String(minimum).endsWith(unit)) return preset.size;
  // WordPress fluid typography interpolates between 320px and 1600px viewports.
  const scale = unit === "px" ? 1 : 16;
  return `clamp(${minimum},${minimum} + ((1vw - 3.2px) * ${((max - min) * scale / 12.8).toFixed(5)}),${maximum})`;
}
export function compileThemeStyles(document: ThemeJSON, scope = ".worldact-theme", overrides: ThemeStyleOverrides = {}) {
  const output: string[] = [], settings = document.settings || {}, styles = document.styles || {};
  const variables: string[] = [];
  const presets: [string, any[], string][] = [
    ["color", settings.color?.palette || [], "color"],
    ["gradient", settings.color?.gradients || [], "gradient"],
    ["font-family", settings.typography?.fontFamilies || [], "fontFamily"],
    ["font-size", settings.typography?.fontSizes || [], "size"],
    ["spacing", settings.spacing?.spacingSizes || [], "size"],
    ["shadow", settings.shadow?.presets || [], "shadow"],
    ["aspect-ratio", settings.dimensions?.aspectRatios || [], "ratio"],
  ];
  for (const [type, entries, property] of presets) for (const entry of entries) {
    const value = type === "font-size" ? fluidSize(entry) : entry[property];
    if (!entry.slug || !value) continue;
    variables.push(`--wp--preset--${type}--${entry.slug}:${themeValue(value, document)}`);
    if (type === "color") {
      output.push(`${scope} .has-${entry.slug}-color{color:var(--wp--preset--color--${entry.slug})!important}`);
      output.push(`${scope} .has-${entry.slug}-background-color{background-color:var(--wp--preset--color--${entry.slug})!important}`);
      output.push(`${scope} .has-${entry.slug}-border-color{border-color:var(--wp--preset--color--${entry.slug})!important}`);
    } else if (type === "font-size") output.push(`${scope} .has-${entry.slug}-font-size{font-size:var(--wp--preset--font-size--${entry.slug})!important}`);
    else if (type === "font-family") output.push(`${scope} .has-${entry.slug}-font-family{font-family:var(--wp--preset--font-family--${entry.slug})!important}`);
    else if (type === "gradient") output.push(`${scope} .has-${entry.slug}-gradient-background{background:var(--wp--preset--gradient--${entry.slug})!important}`);
  }
  for (const family of settings.typography?.fontFamilies || []) for (const face of family.fontFace || []) {
    const attributes = Object.entries(face).filter(([name]) => name !== "src").map(([name, value]) => `${kebab(name)}:${value}`);
    const sources = (Array.isArray(face.src) ? face.src : [face.src]).filter(Boolean).map((src: string) => `url(${JSON.stringify(src)})`).join(",");
    if (sources) output.unshift(`@font-face{${attributes.join(";")};font-display:${face.fontDisplay || "swap"};src:${sources}}`);
  }
  variables.push(`--wp--style--global--content-size:${settings.layout?.contentSize || "650px"}`);
  variables.push(`--wp--style--global--wide-size:${settings.layout?.wideSize || "1200px"}`);
  for (const side of ["top", "right", "bottom", "left"])
    variables.push(`--wp--style--root--padding-${side}:${themeValue(styles.spacing?.padding?.[side] || "0px", document)}`);
  const visitCustom = (value: ThemeJSON, prefix: string) => {
    for (const [key, item] of Object.entries(value))
      if (item && typeof item === "object") visitCustom(item, prefix + "--" + kebab(key));
      else variables.push(prefix + "--" + kebab(key) + ":" + themeValue(item, document));
  };
  visitCustom(settings.custom || {}, "--wp--custom");
  output.push(`${scope}{${variables.join(";")}}`);
  // Root padding belongs to wp-site-blocks, matching WordPress global styles.
  const { spacing, ...rootStyles } = styles;
  ruleTree({ ...rootStyles, spacing: { ...spacing, padding: undefined } }, scope, document, output);
  if (spacing?.padding) ruleTree({ spacing: { padding: settings.useRootPaddingAwareAlignments ? {top:spacing.padding.top,bottom:spacing.padding.bottom} : spacing.padding } }, scope + " > .wp-site-blocks", document, output);
  if (settings.useRootPaddingAwareAlignments) {
    output.push(`${scope} .has-global-padding{padding-right:var(--wp--style--root--padding-right);padding-left:var(--wp--style--root--padding-left)}`);
    output.push(`${scope} .has-global-padding > .alignfull{margin-right:calc(var(--wp--style--root--padding-right) * -1);margin-left:calc(var(--wp--style--root--padding-left) * -1)}`);
    output.push(`${scope} .has-global-padding :where(:not(.alignfull.is-layout-flow) > .has-global-padding:not(.wp-block-block,.alignfull)){padding-right:0;padding-left:0}`);
    output.push(`${scope} .has-global-padding :where(:not(.alignfull.is-layout-flow) > .has-global-padding:not(.wp-block-block,.alignfull)) > .alignfull{margin-left:0;margin-right:0}`);
  }
  for (const [name, value] of Object.entries(styles.blocks || {})) {
    const selector = scope + " .wp-block-" + name.replace(/^core\//, "");
    ruleTree(value as ThemeJSON, selector, document, output);
    for (const [variation, variationStyle] of Object.entries((value as ThemeJSON).variations || {})) {
      const target = selector + ".is-style-" + variation;
      ruleTree(variationStyle as ThemeJSON, target, document, output);
    }
  }
  const custom: string[] = [];
  if (overrides.backgroundColor) custom.push("background-color:" + overrides.backgroundColor);
  if (overrides.textColor) custom.push("color:" + overrides.textColor);
  const font = (value:string) => value === "System" ? "-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" : ["serif","sans-serif"].includes(value) ? value : JSON.stringify(value);
  if (overrides.fontFamily) custom.push("font-family:" + font(overrides.fontFamily));
  if (overrides.contentWidth) custom.push("--wp--style--global--wide-size:" + overrides.contentWidth + "px");
  if (overrides.spacing) custom.push("--wp--style--block-gap:" + overrides.spacing + "px");
  if (custom.length) output.push(scope + "{" + custom.join(";") + "}");
  if (overrides.accentColor) output.push(`${scope} .wp-block-post-content a,${scope} .wp-block-comment-content a{color:${overrides.accentColor}}`);
  if (overrides.headingFont) output.push(`${scope} :is(h1,h2,h3,h4,h5,h6){font-family:${font(overrides.headingFont)}}`);
  return output.join("\n");
}
