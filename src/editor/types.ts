/** Durable block data. Gutenberg's transient client IDs and selection are not saved. */
export type SerializedBlock = {
  name: string;
  attributes: Record<string, unknown>;
  innerBlocks: SerializedBlock[];
};

export type GutenbergBlock = SerializedBlock;
