declare module "@wordpress/block-library" {
  /** Registers the official core blocks; editor availability is controlled separately. */
  export function registerCoreBlocks(): void;
}

declare module "@wordpress/format-library";
declare module "@worldact/wordpress-lock-unlock" {
  /** The installed core module's actual lock/unlock pair, preserving private key identity. */
  export function unlock<T = any>(value: object): T;
}

declare module "@arraypress/waveform-player/dist/waveform-player-no-autoinit.esm.js" {
  export { default } from "@arraypress/waveform-player";
}
declare module "@wordpress/block-library/build-module/utils/waveform-utils.mjs" {
  export function initWaveformPlayer(
    element: HTMLElement,
    options: Record<string, unknown>,
  ): {
    instance: import("@arraypress/waveform-player").default;
    container: HTMLElement;
    destroy: () => void;
  };
  export function updateSeekControlLabel(
    instance: import("@arraypress/waveform-player").default,
    label: string,
  ): void;
  export function setupPlayButtonArtwork(
    container: HTMLElement,
    url: string,
  ): void;
}
