export type VideoEmbed = {
  src: string;
  provider: "YouTube" | "Vimeo";
  title: string;
  width: number;
  height: number;
};

/** Build a player URL from a recognized video ID, never from arbitrary HTML. */
export function parseVideoEmbed(value: string): VideoEmbed | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ].includes(host)
  ) {
    id =
      path[0] === "watch"
        ? url.searchParams.get("v") || undefined
        : ["embed", "shorts", "live"].includes(path[0])
          ? path[1]
          : undefined;
  } else if (["youtu.be", "www.youtu.be"].includes(host)) id = path[0];
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
    const player = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    const start = url.searchParams.get("start") || url.searchParams.get("t");
    if (start && /^\d{1,6}s?$/.test(start))
      player.searchParams.set("start", String(parseInt(start, 10)));
    return {
      src: player.href,
      provider: "YouTube",
      title: "YouTube video",
      width: 640,
      height: 360,
    };
  }
  if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
    id = host === "player.vimeo.com" && path[0] === "video" ? path[1] : path[0];
    if (!id || !/^\d{1,12}$/.test(id)) return null;
    const player = new URL(`https://player.vimeo.com/video/${id}`);
    const hash =
      url.searchParams.get("h") ||
      (host === "player.vimeo.com" ? undefined : path[1]);
    if (hash && /^[a-f0-9]{6,64}$/i.test(hash))
      player.searchParams.set("h", hash);
    return {
      src: player.href,
      provider: "Vimeo",
      title: "Vimeo video",
      width: 640,
      height: 360,
    };
  }
  return null;
}
