import { setFreeformContentHandlerName } from "@wordpress/blocks";

/** Register the source parser fallback before the legacy editor is lazily loaded. */
export function registerClassicContentHandler(): void {
  setFreeformContentHandlerName("core/freeform");
}
