export type ExportContent = "all" | "posts" | "pages" | "attachment";
export type ExportSelection = {
  content: ExportContent;
  category: string;
  author: string;
  startDate: string;
  endDate: string;
  status: string;
};
export const emptyExportSelection: ExportSelection = {
  content: "all",
  category: "",
  author: "",
  startDate: "",
  endDate: "",
  status: "",
};
export function wxrExportQuery(selection: ExportSelection) {
  const query = new URLSearchParams({
    format: "wxr",
    content: selection.content,
  });
  if (!["all", "posts", "pages", "attachment"].includes(selection.content))
    throw new Error("Choose a content type.");
  if (selection.content === "all") return query;
  for (const key of [
    "author",
    ...(selection.content === "posts" ? ["category"] : []),
  ] as const) {
    const value = selection[key as "author" | "category"];
    if (!value) continue;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2147483647)
      throw new Error("Choose a valid export filter.");
    query.set(key, value);
  }
  for (const key of ["startDate", "endDate"] as const) {
    const value = selection[key];
    if (!value) continue;
    if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value))
      throw new Error("Choose a valid export month.");
    query.set(key, value);
  }
  if (
    selection.startDate &&
    selection.endDate &&
    selection.startDate > selection.endDate
  )
    throw new Error("The end month must be on or after the start month.");
  if (selection.content !== "attachment" && selection.status) {
    if (
      !["publish", "future", "draft", "pending", "private", "trash"].includes(
        selection.status,
      )
    )
      throw new Error("Choose a valid publishing status.");
    query.set("status", selection.status);
  }
  return query;
}

export function exportCategoryLabels(
  categories: Array<{ id: number; name: string; parentId: number | null }>,
) {
  const byId = new Map(categories.map((category) => [category.id, category])),
    children = new Map<number | null, typeof categories>();
  for (const category of categories) {
    const parent =
      category.parentId !== null && byId.has(category.parentId)
        ? category.parentId
        : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(category);
  }
  const output: Array<(typeof categories)[number] & { label: string }> = [],
    seen = new Set<number>();
  function append(root: (typeof categories)[number]) {
    const stack = [{ category: root, depth: 0 }];
    while (stack.length) {
      const { category, depth } = stack.pop()!;
      if (seen.has(category.id)) continue;
      seen.add(category.id);
      output.push({
        ...category,
        label: `${"— ".repeat(Math.min(depth, 20))}${category.name}`,
      });
      for (const child of [...(children.get(category.id) || [])].reverse())
        stack.push({ category: child, depth: depth + 1 });
    }
  }
  for (const root of children.get(null) || []) append(root);
  for (const category of categories)
    if (!seen.has(category.id)) append(category);
  return output;
}
