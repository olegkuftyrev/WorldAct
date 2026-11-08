/** Private own-account flags. Public author DTOs never select these fields. */
export function profileOptionsSQL(alias: "u" | "" = "") {
  const prefix = alias ? alias + "." : "";
  return `(${prefix}profile->'showAdminBar' IS DISTINCT FROM 'false'::jsonb) AS "showAdminBar", ((${prefix}profile->'commentShortcuts')='true'::jsonb) IS TRUE AS "commentShortcuts"`;
}
