import { ResourceState, useResource } from "./AdminUI";

type TemplateChoice = { id: number; slug: string; title: string };

export default function PostTemplateSelect({
  type,
  value,
  onChange,
  allowNoChange = false,
}: {
  type: "post" | "page";
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  allowNoChange?: boolean;
}) {
  const resource = useResource<{ templates: TemplateChoice[] }>(
    `/posts/templates?type=${type}`,
  );
  const templates = resource.data?.templates || [];
  return (
    <div className="post-template-control">
      <label>
        Template
        <select
          value={value === undefined ? "keep" : `template:${value}`}
          disabled={resource.loading}
          onChange={(event) =>
            onChange(
              event.target.value === "keep"
                ? undefined
                : event.target.value.slice(9),
            )
          }
        >
          {allowNoChange && <option value="keep">— No change —</option>}
          <option value="template:">Default template</option>
          {value && !templates.some((template) => template.slug === value) && (
            <option value={`template:${value}`}>{value} (unavailable)</option>
          )}
          {templates.map((template) => (
            <option key={template.slug} value={`template:${template.slug}`}>
              {template.title || template.slug}
            </option>
          ))}
        </select>
      </label>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={resource.reload}
      />
    </div>
  );
}
