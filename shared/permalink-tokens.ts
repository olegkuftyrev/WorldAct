/** The bounded custom structures supported by WorldAct. Keep settings help,
 * validation, replacement and resolver captures on this same inventory. */
export const permalinkTokens = [
  { name: "year", capture: "(\\d+)", identity: false },
  { name: "monthnum", capture: "(\\d+)", identity: false },
  { name: "day", capture: "(\\d+)", identity: false },
  { name: "hour", capture: "(\\d{1,2})", identity: false },
  { name: "minute", capture: "(\\d{1,2})", identity: false },
  { name: "second", capture: "(\\d{1,2})", identity: false },
  { name: "post_id", capture: "(\\d+)", identity: true },
  { name: "postname", capture: "([^/]+)", identity: true },
  { name: "category", capture: "(.+?)", identity: false },
] as const;

export type PermalinkToken = (typeof permalinkTokens)[number]["name"];
export const permalinkTokenHelp = permalinkTokens.map(token => `%${token.name}%`).join(", ");
export const permalinkTokenCaptures = Object.fromEntries(
  permalinkTokens.map(token => [token.name, token.capture]),
) as Record<PermalinkToken, string>;
export const permalinkTokenPattern = () => new RegExp(
  "%((?:" + permalinkTokens.map(token => token.name).join("|") + "))%", "g",
);
export const permalinkIdentityPattern = new RegExp(
  "%(" + permalinkTokens.filter(token => token.identity).map(token => token.name).join("|") + ")%",
);
