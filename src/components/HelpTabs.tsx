import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

export type HelpTab = { id: string; title: string; content: ReactNode };

export default function HelpTabs({
  tabs,
  sidebar,
}: {
  tabs: HelpTab[];
  sidebar?: ReactNode;
}) {
  const [active, setActive] = useState(tabs[0]?.id || "");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    setActive(tabs[0]?.id || "");
  }, [tabs[0]?.id]);
  const current = tabs.find((tab) => tab.id === active) || tabs[0];
  return (
    <div className="worldact-contextual-help">
      <div
        className="contextual-help-tabs"
        role="tablist"
        aria-label="Help topics"
        aria-orientation="vertical"
      >
        <ul>
          {tabs.map((tab, index) => (
            <li key={tab.id} className={current?.id === tab.id ? "active" : ""}>
              <button
                ref={(element) => {
                  buttons.current[index] = element;
                }}
                id={`help-tab-${tab.id}`}
                role="tab"
                type="button"
                aria-selected={current?.id === tab.id}
                aria-controls={`help-panel-${tab.id}`}
                tabIndex={current?.id === tab.id ? 0 : -1}
                onClick={() => setActive(tab.id)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === "ArrowDown" || event.key === "ArrowRight")
                    next = (index + 1) % tabs.length;
                  else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
                    next = (index + tabs.length - 1) % tabs.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = tabs.length - 1;
                  else return;
                  event.preventDefault();
                  setActive(tabs[next].id);
                  buttons.current[next]?.focus();
                }}
              >
                {tab.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="contextual-help-tabs-wrap">
        {tabs.map((tab) => (
          <section
            className="help-tab-content"
            key={tab.id}
            id={`help-panel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`help-tab-${tab.id}`}
            hidden={current?.id !== tab.id}
            tabIndex={0}
          >
            {tab.content}
          </section>
        ))}
      </div>
      <aside className="contextual-help-sidebar">
        {sidebar || (
          <>
            <p>
              <strong>For more information:</strong>
            </p>
            <p>
              <Link to="/admin/about">About WorldAct</Link>
            </p>
            <p>
              <Link to="/">Visit your site</Link>
            </p>
          </>
        )}
      </aside>
    </div>
  );
}

export function screenHelp(pathname: string, search = ""): HelpTab[] {
  const tab = (id: string, title: string, content: ReactNode) => ({
    id,
    title,
    content,
  });
  if (/\/posts\/(categories|tags)$/.test(pathname))
    return [
      tab(
        "terms-overview",
        "Overview",
        <>
          <p>
            Categories and tags organize your posts. Use the search box to find
            a term. Select a column heading to change the sort order.
          </p>
          <p>
            Screen Options lets you choose optional columns and the number of
            terms shown on each page.
          </p>
        </>,
      ),
      tab(
        "terms-adding",
        "Adding and Editing",
        <>
          <p>
            Enter a name, an optional URL slug, and a description, then add the
            term. Categories can have a parent category; tags do not have a
            hierarchy.
          </p>
          <p>
            Select Edit beneath a term to load its details into the form.
            Deleting a term does not delete its posts.
          </p>
        </>,
      ),
    ];
  if (/\/admin\/(posts|pages)$/.test(pathname))
    return [
      tab(
        "content-overview",
        "Overview",
        <>
          <p>
            This screen lists your content. Use the status links to show
            published items, drafts, scheduled content, or items in the Trash.
            Search finds matching content, and filters narrow the list by date
            or category.
          </p>
          <p>
            Choose columns, items per page, and list or excerpt display in
            Screen Options. Your choices are saved to your account.
          </p>
        </>,
      ),
      tab(
        "content-actions",
        "Available Actions",
        <>
          <p>
            Select a title or Edit to open the editor. Quick Edit changes an
            item without leaving the list. View opens published content on your
            site.
          </p>
          <p>
            Trash moves an item out of your active content. From the Trash,
            Restore returns it to drafts and Delete Permanently removes it.
          </p>
        </>,
      ),
      tab(
        "content-bulk",
        "Bulk Actions",
        <>
          <p>
            Select the checkbox next to each item, choose an available bulk
            action, and select Apply. The checkbox in the table heading selects
            the current page.
          </p>
          <p>
            Permanent deletion cannot be undone. Review the selected items
            before confirming it.
          </p>
        </>,
      ),
    ];
  if (pathname.endsWith("/comments"))
    return [
      tab(
        "comments-overview",
        "Overview",
        <>
          <p>
            Comments are messages left on your posts and pages. Status links
            show pending, approved, spam, or trashed comments. Search matches
            the author, email address, comment text, or post title.
          </p>
          <p>
            Screen Options controls optional columns and comments per page.
            Sorting and filters are included in the page URL.
          </p>
        </>,
      ),
      tab(
        "comments-moderation",
        "Moderating Comments",
        <>
          <p>
            Approve makes a comment visible when the post allows comments.
            Unapprove holds it for review. Spam and Trash remove it from the
            active list. Restore returns a comment to pending review.
          </p>
          <p>
            Use the row checkboxes and bulk actions to moderate multiple
            comments. Permanently deleting a comment cannot be undone.
          </p>
        </>,
      ),
      tab(
        "comments-editing",
        "Editing and Replying",
        <>
          <p>
            Quick Edit and Edit change the author details, comment text, and
            status. Reply adds a threaded response using your account details.
            Formatting buttons insert supported HTML.
          </p>
          <p>
            If another window changes a comment before you save, your text is
            retained and the update is rejected. Reopen the latest comment
            before trying again.
          </p>
        </>,
      ),
    ];
  if (pathname.endsWith("/profile") || /\/users\/\d+$/.test(pathname))
    return [
      tab(
        "profile-overview",
        "Overview",
        <>
          <p>
            Your profile controls your public name, biography, contact details,
            and administration color scheme. Select Update Profile to save your
            changes.
          </p>
          <p>
            Changing your password requires your current password when editing
            your own account. Log Out Everywhere Else keeps this session and
            signs out your other sessions.
          </p>
        </>,
      ),
      tab(
        "profile-public",
        "Public Profile",
        <p>
          Your display name, biography, and website may be shown with your
          published content. Your email address is used for account
          administration.
        </p>,
      ),
      tab(
        "profile-applications",
        "Application Passwords",
        <>
          <p>
            Create a named application password to connect an application to the
            REST API with this account's permissions. Copy the generated
            password before selecting Done; it is shown only once.
          </p>
          <p>
            Rename a password to identify its application. Revoke removes its
            access immediately. Revoke All affects application passwords for
            this account and keeps browser sessions signed in.
          </p>
        </>,
      ),
    ];
  if (pathname.endsWith("/users"))
    return [
      tab(
        "users-overview",
        "Overview",
        <p>
          Manage the accounts that can sign in to your site. Filter by role or
          search for an account, then select its username to edit the profile.
        </p>,
      ),
      tab(
        "users-roles",
        "User Roles",
        <>
          <p>
            Administrators manage the site. Editors manage content by all
            authors. Authors publish their own posts. Contributors prepare posts
            for review. Subscribers manage their own profile.
          </p>
          <p>
            When deleting another user, choose whether to delete their content
            or assign it to a remaining user. Your own account cannot be deleted
            from this list.
          </p>
        </>,
      ),
    ];
  if (pathname.endsWith("/media"))
    return [
      tab(
        "media-library",
        "Media Library",
        <>
          <p>
            Upload images, audio, video, and documents for your content. Search
            or choose a media type to narrow the library, and switch between
            grid and list views.
          </p>
          <p>
            Select a file to edit its title, alternative text, caption, and
            description. Supported images can be cropped, resized, rotated,
            flipped, or restored.
          </p>
        </>,
      ),
    ];
  if (
    pathname.endsWith("/tools") &&
    new URLSearchParams(search).get("tab")?.startsWith("privacy")
  )
    return [
      tab(
        "privacy-requests",
        "Privacy Requests",
        <>
          <p>
            Create an export or erasure request for an email address. The
            requester must confirm the email link before it is processed, unless
            an administrator explicitly verifies and confirms the request.
          </p>
          <p>
            Exports include profile fields and matching comments. Erasure
            anonymizes identifying comment details and revokes exports while
            retaining accounts, content, media, comment text, moderation status,
            and request records.
          </p>
        </>,
      ),
    ];
  if (pathname.endsWith("/settings"))
    return [
      tab(
        "settings-overview",
        "Overview",
        <>
          <p>
            Choose a settings section to configure your site. Changes are
            applied when you select Save Changes. Only administrators can change
            site-wide settings.
          </p>
          <p>
            General controls your site identity and registration. Writing and
            Reading configure content defaults and the homepage. Discussion,
            Media, Permalinks, and Privacy control their corresponding site
            behavior.
          </p>
        </>,
      ),
    ];
  if (pathname.endsWith("/tools"))
    return [
      tab(
        "tools-transfer",
        "Import and Export",
        <>
          <p>
            Export a WorldAct JSON archive to copy supported site content,
            documents, settings, and uploaded files. WordPress XML exchanges
            supported content records; remote attachment files are reported in
            import warnings.
          </p>
          <p>
            Choose a file and review its preview before importing. Replace site
            design and settings is optional and is off by default. The
            destination site URL and administration email remain in place.
          </p>
        </>,
      ),
      tab(
        "tools-import-review",
        "Import Results",
        <p>
          Review the completion notice and its warnings. Unsupported data and
          unresolved references are reported there so you can check the affected
          content after import.
        </p>,
      ),
    ];
  if (pathname.endsWith("/appearance/editor"))
    return [
      tab(
        "design-overview",
        "Site Editor",
        <>
          <p>
            Choose a template, template part, or pattern to edit it with the
            block editor. Save applies the document and any edited site
            entities. Styles changes are saved separately.
          </p>
          <p>
            Synced patterns update everywhere their references are used. The
            code editor accepts canonical block markup and supported HTML.
            Review changes with View site.
          </p>
        </>,
      ),
    ];
  if (pathname === "/admin")
    return [
      tab(
        "dashboard-overview",
        "Overview",
        <>
          <p>
            The Dashboard shows an overview of your site, recent activity, and a
            Quick Draft form. Use Screen Options to choose the available
            widgets.
          </p>
          <p>
            Expand or collapse panels with their heading arrows. Widget order
            and visibility are saved to your account.
          </p>
        </>,
      ),
    ];
  return [
    tab(
      "screen-overview",
      "Overview",
      <>
        <p>
          Use the navigation to manage your site's content, design, accounts,
          and settings. Actions on this screen show loading, error, and
          confirmation notices when appropriate.
        </p>
        <p>
          Select Help on content lists for screen-specific actions and Screen
          Options where display preferences are available.
        </p>
      </>,
    ),
  ];
}
