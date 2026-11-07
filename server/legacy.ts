import { Router } from "express";
import { attachUser, type AuthRequest } from "./auth.js";

const router = Router();
router.get("/wp-login.php", (req, res) => {
  const action =
    typeof req.query.action === "string" ? req.query.action : "login";
  const target =
    action === "register"
      ? "/register"
      : ["lostpassword", "retrievepassword"].includes(action)
        ? "/lost-password"
        : ["rp", "resetpass"].includes(action)
          ? "/reset-password"
          : "/login";
  const params = new URLSearchParams();
  if (
    typeof req.query.redirect_to === "string" &&
    req.query.redirect_to.startsWith("/admin") &&
    !/[\\\r\n]/.test(req.query.redirect_to)
  )
    params.set("redirect_to", req.query.redirect_to.slice(0, 2000));
  if (
    target === "/reset-password" &&
    typeof req.query.token === "string" &&
    /^[a-f0-9]{64}$/.test(req.query.token)
  )
    params.set("token", req.query.token);
  res.redirect(target + (params.size ? `?${params}` : ""));
});
router.use("/wp-admin", attachUser);
router.get(
  ["/wp-admin", "/wp-admin/", "/wp-admin/:file"],
  async (req: AuthRequest, res, next) => {
    const file =
      typeof req.params.file === "string" ? req.params.file : "index.php";
    if (!file.endsWith(".php")) return next();
    const params = new URLSearchParams(),
      query = req.query;
    const page = query.post_type === "page";
    const simple: Record<string, string> = {
      "index.php": "/admin",
      "about.php": "/admin/about",
      "credits.php": "/admin/about",
      "freedoms.php": "/admin/about",
      "privacy.php": "/admin/about",
      "upload.php": "/admin/media",
      "media-new.php": "/admin/media",
      "media.php": "/admin/media",
      "themes.php": "/admin/appearance",
      "site-editor.php": "/admin/appearance/editor",
      "nav-menus.php": "/admin/appearance/menus",
      "plugins.php": "/admin/plugins",
      "plugin-install.php": "/admin/plugins?tab=add",
      "users.php": "/admin/users",
      "user-new.php": "/admin/users?new=1",
      "profile.php": "/admin/profile",
      "import.php": "/admin/tools?tab=import",
      "export.php": "/admin/tools?tab=export",
      "site-health.php": "/admin/tools?tab=health",
    };
    let target = simple[file];
    if (file === "edit.php") {
      target = `/admin/${page ? "pages" : "posts"}`;
      for (const [source, destination] of [
        ["s", "search"],
        ["post_status", "status"],
        ["cat", "category"],
        ["m", "month"],
        ["paged", "page"],
      ])
        if (typeof query[source] === "string")
          params.set(destination, query[source].slice(0, 300));
      if (/^\d{6}$/.test(params.get("month") || ""))
        params.set(
          "month",
          `${params.get("month")!.slice(0, 4)}-${params.get("month")!.slice(4)}`,
        );
    } else if (file === "post-new.php")
      target = `/admin/${page ? "pages" : "posts"}/new`;
    else if (
      file === "post.php" &&
      typeof query.post === "string" &&
      /^[1-9]\d{0,9}$/.test(query.post) &&
      Number(query.post) <= 2147483647
    ) {
      target = `/admin/content/${query.post}`;
    } else if (
      file === "user-edit.php" &&
      typeof query.user_id === "string" &&
      /^[1-9]\d{0,9}$/.test(query.user_id)
    )
      target = `/admin/users/${query.user_id}`;
    else if (file === "edit-tags.php")
      target =
        query.taxonomy === "post_tag"
          ? "/admin/posts/tags"
          : "/admin/posts/categories";
    else if (file === "edit-comments.php") {
      target = "/admin/comments";
      const status = {
        moderated: "pending",
        approved: "approved",
        spam: "spam",
        trash: "trash",
        all: "all",
      }[String(query.comment_status)];
      if (status) params.set("status", status);
      if (typeof query.s === "string")
        params.set("search", query.s.slice(0, 300));
    } else if (file === "tools.php") {
      target =
        query.page === "export_personal_data"
          ? "/admin/tools?tab=privacy-export"
          : query.page === "remove_personal_data" ||
              query.page === "erase_personal_data"
            ? "/admin/tools?tab=privacy-erase"
            : "/admin/tools";
    } else if (
      /^options-(general|writing|reading|discussion|media|permalink|privacy)\.php$/.test(
        file,
      )
    )
      target = `/admin/settings?tab=${file.slice(8, -4) === "permalink" ? "permalinks" : file.slice(8, -4)}`;
    if (!target) return next();
    res.redirect(
      target +
        (params.size
          ? (target.includes("?") ? "&" : "?") + params.toString()
          : ""),
    );
  },
);
export default router;
