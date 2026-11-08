import { useEffect, useState, type ReactNode } from "react";
import {
  Modal,
  Button,
  TabPanel,
  Notice,
  Spinner,
  CheckboxControl,
} from "@wordpress/components";
import "@wordpress/components/build-style/style.css";
import { api, json } from "../api";
import { errorText } from "./AdminUI";
import "./FontLibrary.css";

type Face = {
  id?: number;
  url: string;
  style: string;
  weight: string;
  stretch: string;
  format: string;
  metadata: Record<string, unknown>;
};
type Family = {
  id: number;
  name: string;
  source: string;
  active: boolean;
  activeThemes: string[];
  faces: Face[];
};
type Collection = {
  key: string;
  name: string;
  faceCount: number;
  faces: Face[];
};
type Library = { theme: string; families: Family[]; collection: Collection[] };
export default function FontLibrary({
  theme,
  onClose,
  onChange,
  embedded = false,
}: {
  theme: string;
  onClose: () => void;
  onChange: () => void;
  embedded?: boolean;
}) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sample, setSample] = useState(
    "The quick brown fox jumps over the lazy dog.",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    setLibrary(await api<Library>(`/fonts?theme=${encodeURIComponent(theme)}`));
  }
  useEffect(() => {
    let active = true;
    api<Library>(`/fonts?theme=${encodeURIComponent(theme)}`)
      .then((value) => {
        if (active) setLibrary(value);
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, [theme]);
  async function run(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
      setNotice(message);
      onChange();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  const family = library?.families.find((item) => item.id === selected);
  const faceCSS = (faces: Face[], name: string) =>
    faces
      .map(
        (face) =>
          `@font-face{font-family:${JSON.stringify(name)};font-style:${face.style};font-weight:${face.weight};font-stretch:${face.stretch};font-display:swap;src:url(${JSON.stringify(face.url)})}`,
      )
      .join("\n");
  return (
    <FontLibraryFrame embedded={embedded} close={onClose} busy={busy}>
      <p>
        Manage the fonts available to this theme. Activated fonts appear in
        typography settings.
      </p>
      {error && (
        <Notice status="error" onRemove={() => setError("")}>
          {error}
        </Notice>
      )}
      {notice && (
        <Notice status="success" onRemove={() => setNotice("")}>
          {notice}
        </Notice>
      )}
      {!library && !error ? (
        <Spinner />
      ) : (
        library && (
          <TabPanel
            tabs={[
              { name: "library", title: "Library" },
              { name: "upload", title: "Upload" },
              { name: "collection", title: "Bundled fonts" },
            ]}
            onSelect={() => {
              setSelected(null);
              setSearch("");
            }}
          >
            {(tab: { name: string }) =>
              tab.name === "upload" ? (
                <div className="worldact-font-upload">
                  <h2>Upload fonts</h2>
                  <p>
                    Add .ttf, .otf, .woff, or .woff2 files, up to 8 MiB each.
                    Font family and styles are read from the font itself.
                  </p>
                  <label className="worldact-font-upload-label">
                    Font files
                    <input
                      aria-label="Font files"
                      type="file"
                      accept=".ttf,.otf,.woff,.woff2"
                      multiple
                      disabled={busy}
                      onChange={(event) => {
                        const files = Array.from(event.target.files || []);
                        event.target.value = "";
                        if (files.length)
                          void run(async () => {
                            for (const file of files) {
                              if (file.size > 8 * 1024 * 1024)
                                throw new Error(`${file.name} exceeds 8 MiB.`);
                              const body = new FormData();
                              body.append("file", file);
                              await api("/fonts/upload", {
                                method: "POST",
                                body,
                              });
                            }
                          }, "Fonts uploaded. Activate them in the Library tab to use them in this theme.");
                      }}
                    />
                  </label>
                  <p className="description">
                    Only upload fonts you have permission to use. Copyright and
                    license metadata, when present, are kept with each font.
                  </p>
                </div>
              ) : family && tab.name === "library" ? (
                <div className="worldact-font-detail">
                  <Button variant="tertiary" onClick={() => setSelected(null)}>
                    ← All fonts
                  </Button>
                  <h2>{family.name}</h2>
                  <p>
                    {family.faces.length}{" "}
                    {family.faces.length === 1 ? "style" : "styles"}
                  </p>
                  <style>{faceCSS(family.faces, family.name)}</style>
                  <CheckboxControl
                    label="Activate for this theme"
                    checked={family.active}
                    disabled={busy}
                    onChange={(active: boolean) =>
                      void run(
                        () =>
                          api(
                            `/fonts/${family.id}/activation`,
                            json("PUT", { theme, active }),
                          ),
                        active
                          ? "Font activated for this theme."
                          : "Font deactivated. Any global style selections using it have been reset.",
                      )
                    }
                  />
                  <label className="worldact-font-sample-label">
                    Preview text
                    <input
                      value={sample}
                      maxLength={500}
                      onChange={(event) => setSample(event.target.value)}
                    />
                  </label>
                  <div className="worldact-font-faces">
                    {family.faces.map((face, index) => (
                      <div key={face.id || index}>
                        <p>
                          {face.style} · {face.weight}
                          {face.stretch !== "normal"
                            ? ` · ${face.stretch}`
                            : ""}
                        </p>
                        <div
                          className="worldact-font-sample"
                          style={{
                            fontFamily: JSON.stringify(family.name),
                            fontStyle: face.style,
                            fontWeight: Number(face.weight.split(" ")[0]),
                          }}
                        >
                          {sample}
                        </div>
                        {Boolean(
                          face.metadata.copyright ||
                          face.metadata.license ||
                          face.metadata.licenseURL,
                        ) && (
                          <details>
                            <summary>Font information</summary>
                            {[
                              face.metadata.copyright,
                              face.metadata.license,
                              face.metadata.licenseURL,
                            ]
                              .filter(Boolean)
                              .map((value, index) => (
                                <p
                                  key={index}
                                  className="worldact-font-license"
                                >
                                  {String(value)}
                                </p>
                              ))}
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="worldact-font-remove">
                    <Button
                      variant="tertiary"
                      isDestructive
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            `Remove ${family.name} and all its styles from the library? This also deactivates the font in every theme.`,
                          )
                        )
                          void run(async () => {
                            await api(`/fonts/${family.id}`, {
                              method: "DELETE",
                            });
                            setSelected(null);
                          }, "Font removed from the library.");
                      }}
                    >
                      Remove font family
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="worldact-font-browse">
                  <label className="worldact-font-search">
                    Search fonts
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  {tab.name === "collection" && (
                    <p>
                      Install local fonts supplied with the bundled themes.
                      These files are already included with WorldAct.
                    </p>
                  )}
                  <div className="worldact-font-grid">
                    {(tab.name === "library"
                      ? library.families
                      : library.collection
                    )
                      .filter((item) =>
                        item.name
                          .toLocaleLowerCase()
                          .includes(search.toLocaleLowerCase()),
                      )
                      .map((item) => {
                        const installed =
                          "id" in item
                            ? item
                            : library.families.find(
                                (family) =>
                                  family.name.toLocaleLowerCase() ===
                                  item.name.toLocaleLowerCase(),
                              );
                        const alias = `worldact-font-preview-${"id" in item ? item.id : item.key}`;
                        return (
                          <article
                            className="worldact-font-card"
                            key={"id" in item ? item.id : item.key}
                          >
                            <style>{faceCSS(item.faces, alias)}</style>
                            <div
                              className="worldact-font-card-preview"
                              style={{ fontFamily: JSON.stringify(alias) }}
                            >
                              Aa
                            </div>
                            <h3>{item.name}</h3>
                            <p>
                              {item.faces.length}{" "}
                              {item.faces.length === 1 ? "style" : "styles"}
                              {installed?.active ? " · Active" : ""}
                            </p>
                            {tab.name === "library" && "id" in item ? (
                              <Button
                                variant="secondary"
                                onClick={() => setSelected(item.id)}
                              >
                                Manage font
                              </Button>
                            ) : installed ? (
                              <span className="worldact-font-installed">
                                Installed
                              </span>
                            ) : "key" in item ? (
                              <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void run(
                                    () =>
                                      api(
                                        "/fonts/install",
                                        json("POST", {
                                          collectionKey: item.key,
                                        }),
                                      ),
                                    "Font installed. Activate it in the Library tab to use it in this theme.",
                                  )
                                }
                              >
                                Install {item.name}
                              </Button>
                            ) : null}
                          </article>
                        );
                      })}
                  </div>
                  {tab.name === "library" && !library.families.length && (
                    <p className="worldact-font-empty">
                      Your library is empty. Upload a font or choose one from
                      Bundled fonts.
                    </p>
                  )}
                </div>
              )
            }
          </TabPanel>
        )
      )}
      {busy && (
        <div className="worldact-font-progress" role="status">
          <Spinner /> Saving font changes…
        </div>
      )}
    </FontLibraryFrame>
  );
}

function FontLibraryFrame({ embedded, close, busy, children }: { embedded: boolean; close: () => void; busy: boolean; children: ReactNode }) {
  return embedded ? <section className="worldact-font-library worldact-font-library-page" aria-label="Font Library">{children}</section> :
    <Modal title="Font Library" onRequestClose={close} className="worldact-font-library" shouldCloseOnClickOutside={!busy}>{children}</Modal>;
}
