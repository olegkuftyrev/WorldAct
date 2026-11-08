import { useContext, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, json, type Role, type User } from "../api";
import {
  errorText,
  Icon,
  Modal,
  Notice,
  ResourceState,
  ScreenTabs,
  Session,
  useResource,
} from "../components/AdminUI";
import {
  ListTableOptions,
  useListTablePreferences,
} from "../components/ScreenOptions";
import { DeleteUserDialog } from "./Accounts";
import "../users.css";

type ListedUser = User & { postCount?: number };
type UsersResult = {
  users: ListedUser[];
  counts?: Partial<Record<Role | "all", number>>;
  pagination?: {
    page: number;
    perPage: number;
    total?: number;
    totalUsers?: number;
    totalPages: number;
  };
};
const roles: Role[] = [
  "administrator",
  "editor",
  "author",
  "contributor",
  "subscriber",
];
const label = (role: string) => role[0].toUpperCase() + role.slice(1);
const emptyForm = {
  username: "",
  email: "",
  displayName: "",
  firstName: "",
  lastName: "",
  website: "",
  password: "",
  role: "subscriber" as Role,
  sendNotification: true,
};

export default function Users() {
  const { user } = useContext(Session);
  const [params, setParams] = useSearchParams();
  const preferences = useListTablePreferences("users");
  const search = params.get("search") || "",
    role = roles.includes(params.get("role") as Role)
      ? params.get("role")!
      : "all";
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const orderby = ["username", "name", "email", "role", "posts"].includes(
    params.get("orderby") || "",
  )
    ? params.get("orderby")!
    : "username";
  const order = params.get("order") === "desc" ? "desc" : "asc";
  const adding = params.get("new") === "1";
  const query = new URLSearchParams({
    page: String(page),
    perPage: String(preferences.value.perPage),
    orderby,
    order,
  });
  if (search) query.set("search", search);
  if (role !== "all") query.set("role", role);
  const resource = useResource<UsersResult>(`/users?${query}`);
  const allUsers = useResource<{ users: User[] }>(
    "/users?perPage=1000&orderby=username&order=asc",
  );
  const [searchDraft, setSearchDraft] = useState(search),
    [selected, setSelected] = useState<number[]>([]),
    [bulk, setBulk] = useState("");
  const [newRole, setNewRole] = useState(""),
    [form, setForm] = useState({ ...emptyForm });
  const [showPassword, setShowPassword] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<{ id: number; message: string }[]>([]),
    [deleting, setDeleting] = useState<number[] | null>(null),
    [removingUser, setRemovingUser] = useState<User | null>(null);
  const users = resource.data?.users || [],
    counts = resource.data?.counts;
  const totalPages = resource.data?.pagination?.totalPages || 1;
  const total =
    resource.data?.pagination?.totalUsers ??
    resource.data?.pagination?.total ??
    users.length;
  useEffect(() => {
    setSearchDraft(search);
    setSelected([]);
  }, [search, role, page]);
  function change(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values))
      value ? next.set(key, value) : next.delete(key);
    if (!("page" in values)) next.delete("page");
    setParams(next);
    setSelected([]);
  }
  function sort(field: string) {
    change({
      orderby: field,
      order: orderby === field && order === "asc" ? "desc" : "asc",
    });
  }
  async function reload() {
    await Promise.all([resource.reload(), allUsers.reload()]);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setErrors([]);
    try {
      const result = await api<{ user: User; message?: string }>(
        "/users",
        json("POST", {
          ...form,
          displayName: form.displayName.trim() || form.username,
        }),
      );
      setNotice(result.message || "New user created.");
      setForm({ ...emptyForm });
      change({ new: "" });
      await reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function applyRole() {
    if (!selected.length || !newRole) return;
    setBusy(true);
    setError("");
    setErrors([]);
    try {
      const result = await api<{
        updated: number;
        errors: { id: number; message: string }[];
      }>(
        "/users/bulk",
        json("POST", { ids: selected, action: "role", role: newRole }),
      );
      setNotice(
        `${result.updated} ${result.updated === 1 ? "user" : "users"} updated.`,
      );
      setErrors(result.errors || []);
      setSelected([]);
      await reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  const pagination = (
    <div className="tablenav-pages worldact-users-pagination">
      <span className="displaying-num">
        {total} {total === 1 ? "item" : "items"}
      </span>
      {totalPages > 1 && (
        <>
          <button
            className="button"
            aria-label="Previous page"
            disabled={page <= 1 || resource.loading}
            onClick={() => change({ page: String(page - 1) })}
          >
            ‹
          </button>
          <span>
            {page} of {totalPages}
          </span>
          <button
            className="button"
            aria-label="Next page"
            disabled={page >= totalPages || resource.loading}
            onClick={() => change({ page: String(page + 1) })}
          >
            ›
          </button>
        </>
      )}
    </div>
  );
  if (user?.role !== "administrator")
    return (
      <>
        <ScreenTabs />
        <main className="wrap">
          <h1>Users</h1>
          <Notice error>You do not have permission to manage users.</Notice>
        </main>
      </>
    );
  return (
    <>
      <ScreenTabs>
        {!adding && (
          <ListTableOptions
            table={preferences}
            itemLabel="users"
            columns={[
              { id: "name", label: "Name" },
              { id: "email", label: "Email" },
              { id: "role", label: "Role" },
              { id: "posts", label: "Posts" },
            ]}
            onApply={() => change({ page: "1" })}
          />
        )}
      </ScreenTabs>
      <main className="wrap worldact-users">
        <h1 className="wp-heading-inline">
          {adding ? "Add New User" : "Users"}
        </h1>{" "}
        {!adding && (
          <Link className="page-title-action" to="?new=1">
            Add New User
          </Link>
        )}
        <hr className="wp-header-end" />
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {error && <Notice error>{error}</Notice>}
        {!!errors.length && (
          <Notice error>
            <ul>
              {errors.map((error) => (
                <li key={error.id}>
                  User #{error.id}: {error.message}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {adding ? (
          <form onSubmit={create}>
            <p>Create a new user and add them to this site.</p>
            <table className="form-table">
              <tbody>
                {[
                  { key: "username", label: "Username", required: true },
                  {
                    key: "email",
                    label: "Email",
                    required: true,
                    type: "email",
                  },
                  { key: "firstName", label: "First Name" },
                  { key: "lastName", label: "Last Name" },
                  { key: "displayName", label: "Display Name" },
                  { key: "website", label: "Website", type: "url" },
                ].map((field) => (
                  <tr key={field.key}>
                    <th scope="row">
                      <label htmlFor={`new-user-${field.key}`}>
                        {field.label}
                        {field.required && " (required)"}
                      </label>
                    </th>
                    <td>
                      <input
                        id={`new-user-${field.key}`}
                        className="regular-text"
                        type={field.type || "text"}
                        required={field.required}
                        value={form[field.key as keyof typeof form] as string}
                        maxLength={
                          field.key === "website"
                            ? 2000
                            : field.key === "username"
                              ? 60
                              : 254
                        }
                        onChange={(event) =>
                          setForm({ ...form, [field.key]: event.target.value })
                        }
                        autoComplete={
                          field.key === "email"
                            ? "off"
                            : field.key === "username"
                              ? "off"
                              : undefined
                        }
                      />
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">
                    <label htmlFor="new-user-password">
                      Password (required)
                    </label>
                  </th>
                  <td>
                    <div className="worldact-new-user-password">
                      <input
                        id="new-user-password"
                        className="regular-text"
                        type={showPassword ? "text" : "password"}
                        required
                        minLength={12}
                        value={form.password}
                        autoComplete="new-password"
                        onChange={(event) =>
                          setForm({ ...form, password: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        className="button"
                        aria-label={
                          showPassword ? "Hide password" : "Show password"
                        }
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        <Icon name={showPassword ? "hidden" : "visibility"} />
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          const values = crypto.getRandomValues(
                            new Uint8Array(24),
                          );
                          const alphabet =
                            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
                          setForm({
                            ...form,
                            password: [...values]
                              .map((value) => alphabet[value % alphabet.length])
                              .join(""),
                          });
                          setShowPassword(true);
                        }}
                      >
                        Generate Password
                      </button>
                    </div>
                    <p className="description">Use at least 12 characters.</p>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Send User Notification</th>
                  <td>
                    <label>
                      <input
                        type="checkbox"
                        checked={form.sendNotification}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            sendNotification: event.target.checked,
                          })
                        }
                      />
                      Send the new user an email about their account
                    </label>
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    <label htmlFor="new-user-role">Role</label>
                  </th>
                  <td>
                    <select
                      id="new-user-role"
                      value={form.role}
                      onChange={(event) =>
                        setForm({ ...form, role: event.target.value as Role })
                      }
                    >
                      {[...roles].reverse().map((role) => (
                        <option value={role} key={role}>
                          {label(role)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="submit">
              <button className="button button-primary" disabled={busy}>
                {busy ? "Adding…" : "Add New User"}
              </button>{" "}
              <Link className="button" to="/admin/users">
                Cancel
              </Link>
            </p>
          </form>
        ) : (
          <>
            <ResourceState
              loading={resource.loading}
              error={resource.error}
              retry={resource.reload}
            />
            <ul className="subsubsub">
              {["all", ...roles].map((value, index) => (
                <li key={value}>
                  {index > 0 && " | "}
                  <Link
                    className={role === value ? "current" : ""}
                    aria-current={role === value ? "page" : undefined}
                    to={`?${new URLSearchParams({ ...Object.fromEntries(params), role: value, page: "1" })}`}
                  >
                    {value === "all" ? "All" : label(value)}{" "}
                    <span className="count">
                      (
                      {counts?.[value as Role | "all"] ??
                        (value === "all"
                          ? allUsers.data?.users.length || 0
                          : allUsers.data?.users.filter(
                              (user) => user.role === value,
                            ).length || 0)}
                      )
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <form
              className="search-box"
              onSubmit={(event) => {
                event.preventDefault();
                change({ search: searchDraft });
              }}
            >
              <input
                type="search"
                aria-label="Search users"
                value={searchDraft}
                maxLength={300}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
              <button className="button">Search Users</button>
            </form>
            <div className="tablenav top">
              <div className="alignleft actions bulkactions">
                <select
                  aria-label="Bulk actions"
                  value={bulk}
                  onChange={(event) => setBulk(event.target.value)}
                >
                  <option value="">Bulk actions</option>
                  <option value="delete">Delete</option>
                </select>
                <button
                  className="button"
                  disabled={busy || !selected.length || !bulk}
                  onClick={() => {
                    if (selected.includes(user.id)) {
                      setError(
                        "Your own account cannot be selected for deletion.",
                      );
                      return;
                    }
                    setDeleting([...selected]);
                  }}
                >
                  Apply
                </button>
                <select
                  aria-label="Change role to"
                  value={newRole}
                  onChange={(event) => setNewRole(event.target.value)}
                >
                  <option value="">Change role to…</option>
                  {roles.map((role) => (
                    <option value={role} key={role}>
                      {label(role)}
                    </option>
                  ))}
                </select>
                <button
                  className="button"
                  disabled={busy || !selected.length || !newRole}
                  onClick={() => void applyRole()}
                >
                  Change
                </button>
              </div>
              {pagination}
            </div>
            <table
              data-hidden-columns={preferences.value.hiddenColumns.join(" ")}
              className="wp-list-table widefat fixed striped users"
            >
              <thead>
                <tr>
                  <td className="check-column">
                    <input
                      type="checkbox"
                      aria-label="Select all users"
                      checked={
                        users.length > 0 &&
                        users.every((user) => selected.includes(user.id))
                      }
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? users.map((user) => user.id)
                            : [],
                        )
                      }
                    />
                  </td>
                  {[
                    {
                      id: "username",
                      title: "Username",
                      className: "column-username column-primary",
                    },
                    { id: "name", title: "Name", className: "column-name" },
                    { id: "email", title: "Email", className: "column-email" },
                    { id: "role", title: "Role", className: "column-role" },
                    { id: "posts", title: "Posts", className: "column-posts" },
                  ].map((column) => (
                    <th
                      key={column.id}
                      scope="col"
                      className={column.className}
                      aria-sort={
                        orderby === column.id
                          ? order === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        className="button-link"
                        onClick={() => sort(column.id)}
                      >
                        {column.title}{" "}
                        {orderby === column.id && (order === "asc" ? "↑" : "↓")}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((item) => (
                  <tr key={item.id}>
                    <th scope="row" className="check-column">
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.username}`}
                        checked={selected.includes(item.id)}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, item.id]
                              : selected.filter((id) => id !== item.id),
                          )
                        }
                      />
                    </th>
                    <td className="column-username column-primary">
                      <strong>
                        <Link
                          className="row-title"
                          to={`/admin/users/${item.id}`}
                        >
                          {item.username}
                        </Link>
                        {item.id === user.id && " (you)"}
                      </strong>
                      <div className="row-actions visible">
                        <Link to={`/admin/users/${item.id}`}>Edit</Link>
                        {item.id !== user.id && (
                          <>
                            {" | "}
                            <button
                              className="button-link button-link-delete"
                              disabled={busy}
                              onClick={() => setRemovingUser(item)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="column-name" data-colname="Name">
                      {[item.firstName, item.lastName]
                        .filter(Boolean)
                        .join(" ") || item.displayName}
                    </td>
                    <td className="column-email" data-colname="Email">
                      <a href={`mailto:${item.email}`}>{item.email}</a>
                    </td>
                    <td className="column-role" data-colname="Role">
                      {label(item.role)}
                    </td>
                    <td className="column-posts" data-colname="Posts">
                      {item.postCount !== undefined ? (
                        <Link to={`/admin/posts?author=${item.id}`}>
                          {item.postCount}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
                {!resource.loading && !users.length && (
                  <tr className="no-items">
                    <td colSpan={6}>No users found.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="tablenav bottom">{pagination}</div>
          </>
        )}
        {removingUser && (
          <DeleteUserDialog
            target={removingUser}
            users={allUsers.data?.users || []}
            currentUserId={user.id}
            onClose={() => setRemovingUser(null)}
            onDeleted={async () => {
              setRemovingUser(null);
              setNotice("User deleted.");
              await reload();
            }}
          />
        )}
        {deleting && (
          <BulkDeleteUsers
            ids={deleting}
            users={allUsers.data?.users || []}
            currentUserId={user.id}
            close={() => setDeleting(null)}
            saved={async (result) => {
              setNotice(
                `${result.updated} ${result.updated === 1 ? "user" : "users"} deleted.`,
              );
              setErrors(result.errors || []);
              setDeleting(null);
              setSelected([]);
              await reload();
            }}
          />
        )}
      </main>
    </>
  );
}

function BulkDeleteUsers({
  ids,
  users,
  currentUserId,
  close,
  saved,
}: {
  ids: number[];
  users: User[];
  currentUserId: number;
  close: () => void;
  saved: (result: {
    updated: number;
    errors: { id: number; message: string }[];
  }) => Promise<void>;
}) {
  const [choice, setChoice] = useState("reassign"),
    [reassignTo, setReassignTo] = useState(String(currentUserId)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const available = users.filter((user) => !ids.includes(user.id));
  return (
    <Modal
      title="Delete Users"
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        className="delete-user-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const result = await api<{
              updated: number;
              errors: { id: number; message: string }[];
            }>(
              "/users/bulk",
              json("POST", {
                ids,
                action: "delete",
                ...(choice === "reassign"
                  ? { reassignTo: Number(reassignTo) }
                  : { deleteContent: true }),
              }),
            );
            await saved(result);
          } catch (reason) {
            setError(errorText(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>You have selected these users for deletion:</p>
        <ul>
          {ids.map((id) => (
            <li key={id}>
              <strong>
                {users.find((user) => user.id === id)?.username ||
                  `User #${id}`}
              </strong>
            </li>
          ))}
        </ul>
        <p>What should be done with content owned by these users?</p>
        <fieldset>
          <label>
            <input
              type="radio"
              name="delete-users-content"
              checked={choice === "delete"}
              onChange={() => setChoice("delete")}
            />
            Delete all content.
          </label>
          {choice === "delete" && (
            <p className="delete-user-warning">
              Their posts, pages, and uploaded media files will be permanently
              deleted.
            </p>
          )}
          <p>
            <label>
              <input
                type="radio"
                name="delete-users-content"
                checked={choice === "reassign"}
                onChange={() => setChoice("reassign")}
              />
              Attribute all content to:
            </label>
          </p>
          <select
            aria-label="Reassign content to"
            disabled={choice !== "reassign"}
            required={choice === "reassign"}
            value={reassignTo}
            onChange={(event) => setReassignTo(event.target.value)}
          >
            {available.map((user) => (
              <option value={user.id} key={user.id}>
                {user.displayName} ({user.username})
              </option>
            ))}
          </select>
        </fieldset>
        <p>Deleting these accounts cannot be undone.</p>
        {error && <Notice error>{error}</Notice>}
        <div className="application-password-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button
            className="button button-danger"
            disabled={
              busy ||
              (choice === "reassign" &&
                !available.some((user) => String(user.id) === reassignTo))
            }
          >
            {busy ? "Deleting…" : "Confirm Deletion"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
