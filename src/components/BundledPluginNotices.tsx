import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";
import "./BundledPluginNotices.css";
export default function BundledPluginNotices() {
  const location = useLocation(),
    [hello, setHello] = useState<{ lyric: string; attribution: string } | null>(
      null,
    );
  useEffect(() => {
    let active = true;
    const reload = () => {
      api<{ helloDolly: { lyric: string; attribution: string } | null }>(
        "/admin/plugin-notices",
      )
        .then(({ helloDolly }) => {
          if (active) setHello(helloDolly);
        })
        .catch(() => {
          if (active) setHello(null);
        });
    };
    reload();
    window.addEventListener("worldact-plugins-updated", reload);
    return () => {
      active = false;
      window.removeEventListener("worldact-plugins-updated", reload);
    };
  }, [location.pathname]);
  if (!hello || /\/(?:editor|new)(?:\/|$)/.test(location.pathname)) return null;
  return (
    <p id="dolly">
      <span className="screen-reader-text">{hello.attribution} </span>
      <span dir="ltr" lang="en">
        {hello.lyric}
      </span>
    </p>
  );
}
