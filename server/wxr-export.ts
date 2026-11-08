import { parse } from "@wordpress/block-serialization-default-parser";
import { z } from "zod";
import { dateArchiveLocalSQL } from "./date-archives.js";
import { HttpError } from "./utils.js";

const month = z.string().regex(/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/, "Choose a valid export month.");
const identifier = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(value => Number(value)).pipe(z.number().int().positive().max(2147483647));
const filters = z.object({
  format: z.literal("wxr"),
  content: z.enum(["all", "posts", "pages", "attachment"]).default("all"),
  category: identifier.optional(),
  author: identifier.optional(),
  startDate: month.optional(),
  endDate: month.optional(),
  status: z.enum(["publish", "future", "draft", "pending", "private", "trash"]).optional(),
}).strict().refine(value => !value.startDate || !value.endDate || value.startDate <= value.endDate, "The end month must be on or after the start month.");
export type WxrExportFilters = z.infer<typeof filters>;
export const readWxrExportFilters = (value: unknown) => filters.parse(value);

/** All column fragments are fixed by the caller; only values enter parameters. */
export function wxrExportWhere(input: WxrExportFilters, timezone: string, media = false) {
  const args: unknown[] = [], where: string[] = [];
  const parameter = (value: unknown) => { args.push(value); return "$" + args.length; };
  if (input.content === "all") return { sql: "TRUE", args };
  if (!media) where.push(`p.type=${parameter(input.content === "pages" ? "page" : "post")}`);
  if (input.author) where.push(`${media ? "m" : "p"}.author_id=${parameter(input.author)}`);
  if (!media && input.status) where.push(`p.status=${parameter(input.status)}`);
  if (!media && input.content === "posts" && input.category)
    where.push(`EXISTS(SELECT 1 FROM post_terms selected_term JOIN terms selected_category ON selected_category.id=selected_term.term_id WHERE selected_term.post_id=p.id AND selected_category.taxonomy='category' AND selected_category.id=${parameter(input.category)})`);
  if (input.startDate || input.endDate) {
    const local = dateArchiveLocalSQL(media ? "m.created_at" : "COALESCE(p.published_at,p.scheduled_at,p.created_at)", args, timezone);
    if (input.startDate) where.push(`${local}>=${parameter(input.startDate + "-01")}::date`);
    if (input.endDate) where.push(`${local}<(${parameter(input.endDate + "-01")}::date+interval '1 month')`);
  }
  return { sql: where.join(" AND ") || "TRUE", args };
}

/** Resolve only fixed reusable/navigation references, never arbitrary saved keys. */
export function wxrEntityReferences(records: any[]) {
  const references = new Map<number, Set<"reusable" | "navigation">>();
  for (const record of records) {
    const raw = record.rawContent ?? record.raw_content;
    const pending: any[] = typeof raw === "string" && raw ? [...parse(raw)] : [...(Array.isArray(record.blocks) ? record.blocks : [])];
    let count = 0;
    while (pending.length) {
      if (++count > 25000) throw new HttpError(413, "An exported block document is too large.");
      const block = pending.pop();
      if (!block || typeof block !== "object") continue;
      const name = block.blockName ?? block.name, attributes = block.attrs ?? block.attributes;
      if ((name === "core/block" || name === "core/navigation") && Number.isInteger(attributes?.ref) && attributes.ref > 0 && attributes.ref <= 2147483647) {
        const kinds = references.get(attributes.ref) || new Set<"reusable" | "navigation">();
        kinds.add(name === "core/block" ? "reusable" : "navigation"); references.set(attributes.ref, kinds);
      }
      if (Array.isArray(block.innerBlocks)) {
        if (pending.length + block.innerBlocks.length > 25000) throw new HttpError(413, "An exported block document is too large.");
        for (const child of block.innerBlocks) pending.push(child);
      }
    }
  }
  return references;
}
