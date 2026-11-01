import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router";
import templates from "virtual:ohb-templates";
import { Preview } from "../components/Preview";
import { ChecksBadge } from "../components/Checks";
import { themesOf, useControls } from "../lib/controls";
import { useCurrentTemplate } from "../lib/current";
import { useFavorites } from "../lib/favorites";
import type { LayoutCheck } from "../lib/preview";

const CARD_WIDTH = 420;

/** Every template side by side, live, under the same controls. */
export function Gallery() {
  const [controls] = useControls();
  const [favorites, toggleFavorite] = useFavorites();
  const [current] = useCurrentTemplate();
  const [params, setParams] = useSearchParams();
  const [checks, setChecks] = useState<Record<string, LayoutCheck[]>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const onlyFavorites = params.get("favorites") === "1";
  const shown = templates.filter((template) => !onlyFavorites || favorites.has(template.name));
  const themes = themesOf(controls.theme);
  const query = params.toString();

  const record = useCallback((key: string, value: LayoutCheck[]) => {
    setChecks((previous) => (previous[key] === value ? previous : { ...previous, [key]: value }));
  }, []);

  const togglePicked = (name: string): void =>
    setPicked((previous) => (previous.includes(name) ? previous.filter((entry) => entry !== name) : [...previous, name].slice(-4)));

  return (
    <section>
      <div className="page-head">
        <h1>{templates.length} templates</h1>
        <label className="inline">
          <input
            type="checkbox"
            checked={onlyFavorites}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.checked) next.set("favorites", "1");
              else next.delete("favorites");
              setParams(next, { replace: true });
            }}
          />
          Favoris seulement ({favorites.size})
        </label>
        {picked.length >= 2 ? (
          <Link className="button" to={`/compare?${new URLSearchParams({ ...Object.fromEntries(params), names: picked.join(",") })}`}>
            Comparer {picked.length}
          </Link>
        ) : (
          <span className="muted">Cochez 2 à 4 templates pour les comparer</span>
        )}
      </div>
      <div className="grid">
        {shown.map((template) => (
          <article key={template.name} className="card" data-current={template.name === current}>
            <Link to={`/t/${template.name}?${query}`} className="card-previews" aria-label={`Ouvrir ${template.name}`}>
              {themes.map((theme) => (
                <Preview
                  key={theme}
                  template={template.name}
                  theme={theme}
                  locale={controls.locale}
                  state={controls.state}
                  width={controls.size.width}
                  height={controls.size.height}
                  fitWidth={CARD_WIDTH / themes.length}
                  onChecks={(value) => record(`${template.name}:${theme}`, value)}
                />
              ))}
            </Link>
            <div className="card-meta">
              <div className="card-title">
                <Link to={`/t/${template.name}?${query}`}>{template.name}</Link>
                {template.name === current ? <span className="badge badge-current">Dans l’app</span> : null}
                {themes.map((theme) => (
                  <ChecksBadge key={theme} checks={checks[`${template.name}:${theme}`]} />
                ))}
              </div>
              <p className="description">{template.description}</p>
              <div className="card-actions">
                <button type="button" className="star" aria-pressed={favorites.has(template.name)} onClick={() => toggleFavorite(template.name)}>
                  {favorites.has(template.name) ? "★ Favori" : "☆ Favori"}
                </button>
                <label className="inline">
                  <input type="checkbox" checked={picked.includes(template.name)} onChange={() => togglePicked(template.name)} />
                  Comparer
                </label>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
