import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import templates from "virtual:ohb-templates";
import { Preview } from "../components/Preview";
import { ChecksList } from "../components/Checks";
import { themesOf, useControls } from "../lib/controls";
import { useCurrentTemplate } from "../lib/current";
import { useFavorites } from "../lib/favorites";
import type { LayoutCheck } from "../lib/preview";

/** One template, large and interactive, with its checks and the way to adopt it. */
export function TemplateDetail() {
  const { name = "" } = useParams();
  const [controls] = useControls();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [favorites, toggleFavorite] = useFavorites();
  const [current, choose] = useCurrentTemplate();
  const [checks, setChecks] = useState<Record<string, LayoutCheck[]>>({});
  const [message, setMessage] = useState("");
  const [width, setWidth] = useState(() => window.innerWidth - 64);
  const index = templates.findIndex((template) => template.name === name);
  const template = templates[index];
  const themes = themesOf(controls.theme);
  const query = params.toString();

  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth - 64);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Left and right arrows walk the templates: the fastest way to compare.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step || index < 0) return;
      const next = templates[(index + step + templates.length) % templates.length];
      if (next) navigate(`/t/${next.name}?${query}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, navigate, query]);

  const record = useCallback((key: string, value: LayoutCheck[]) => {
    setChecks((previous) => ({ ...previous, [key]: value }));
  }, []);

  if (!template) {
    return (
      <p>
        Template inconnu. <Link to="/">Retour à la galerie</Link>
      </p>
    );
  }

  const adopt = async (): Promise<void> => {
    try {
      const configPath = await choose(template.name);
      setMessage(`Enregistré dans ${configPath}. Relancez l’app desktop pour le voir.`);
    } catch (error) {
      setMessage(`Échec : ${error instanceof Error ? error.message : "erreur"}`);
    }
  };

  return (
    <section>
      <div className="page-head">
        <h1>
          {template.name} <span className="muted">{index + 1} / {templates.length}</span>
        </h1>
        <button type="button" className="star" aria-pressed={favorites.has(template.name)} onClick={() => toggleFavorite(template.name)}>
          {favorites.has(template.name) ? "★ Favori" : "☆ Favori"}
        </button>
        {template.name === current ? (
          <span className="badge badge-current">Utilisé par l’app</span>
        ) : (
          <button type="button" className="button" onClick={() => void adopt()}>
            Utiliser dans l’app
          </button>
        )}
        <span className="muted">← → pour passer au template voisin</span>
      </div>
      <p className="description">{template.description}</p>
      {message ? <p className="message">{message}</p> : null}
      <p className="muted">
        Ou en variable d’environnement : <code>OHB_SIGNIN_TEMPLATE={template.name} make start</code>
      </p>
      <div className="detail-previews">
        {themes.map((theme) => (
          <div key={theme} className="detail-preview">
            <Preview
              template={template.name}
              theme={theme}
              locale={controls.locale}
              state={controls.state}
              width={controls.size.width}
              height={controls.size.height}
              fitWidth={Math.max(320, width / themes.length - 16)}
              interactive
              onChecks={(value) => record(theme, value)}
            />
            <ChecksList checks={checks[theme]} />
          </div>
        ))}
      </div>
    </section>
  );
}
