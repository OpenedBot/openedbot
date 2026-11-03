import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { useT } from "../lib/i18n";

/**
 * L'écran d'une URL qui ne mène nulle part : le jumeau d'`AppErrorScreen`
 * pour le cas où le routeur ne TROUVE pas, au lieu de casser.
 *
 * Sans lui, TanStack rend son propre repli : les deux mots « Not Found » en
 * haut à gauche, en anglais, hors de la coque, sans un geste pour repartir.
 * Un lien périmé (un favori, une notification, un chemin réécrit depuis) y
 * laissait l'opérateur dans un cul-de-sac.
 *
 * Il reprend la coque de `/login` (`login.css`, importée globalement par
 * `globals.css`) : colonne éditoriale à gauche, illustration thématisée à
 * droite. C'est le bon voisinage : comme la porte d'entrée, cet écran vit HORS
 * de la coque applicative (le routeur n'a pas de route à lui donner) et doit
 * donc porter lui-même son fond, sa marque et sa zone sûre.
 *
 * Le chemin demandé est écrit à l'écran : c'est la seule chose qui distingue
 * une faute de frappe d'un lien de l'application devenu faux, et celui qui
 * lit la page est le seul à pouvoir faire la différence.
 *
 * `Link` et `router.history` plutôt que des ancres : l'inverse de l'écran
 * d'erreur, et pour la raison inverse : ici le routeur va BIEN, c'est la
 * route qui manque. Une navigation côté client garde la session, le cache et
 * la coque ; un rechargement les jetterait sans rien réparer.
 */
export function NotFoundScreen() {
  const { t } = useT();
  const router = useRouter();
  const { pathname } = useLocation();
  // Une URL ouverte directement (lien collé, favori, notification) n'a pas
  // d'entrée précédente : le bouton « revenir » n'y ferait rien du tout, et
  // un geste qui ne répond pas est pire que pas de geste.
  const canGoBack = router.history.canGoBack();
  return (
    <div className="lg">
      <div className="lg-shell">
        <section className="lg-main">
          <span className="lg-brand">
            <span className="lg-brand-mark">
              <img src="/brand/ohb-icon.webp" alt="" aria-hidden="true" />
            </span>
            <span>ohb</span>
          </span>
          <div className="lg-content">
            <div className="lg-copy">
              <p className="lg-eyebrow">404</p>
              <h1 className="lg-title">{t("notFound.title")}</h1>
              <p className="lg-lead">{t("notFound.description")}</p>
            </div>
            {/* `word-break` : un chemin porte des identifiants qui ne cassent
                sur aucune espace, et déborderaient la colonne sur un téléphone. */}
            <p className="lg-path">{pathname}</p>
            <div className="lg-actions lg-actions--inline">
              <Link to="/" className="lg-submit">
                {t("notFound.home")}
              </Link>
              {canGoBack ? (
                <button type="button" className="lg-secondary" onClick={() => router.history.back()}>
                  {t("notFound.back")}
                </button>
              ) : null}
            </div>
          </div>
          {/* La colonne de `/login` se répartit en trois (marque, contenu,
              pied) : sans ce vide, le contenu remonterait au lieu d'être au
              centre comme sur la porte d'entrée. */}
          <span aria-hidden="true" />
        </section>
        <aside className="lg-panel" aria-hidden="true" />
      </div>
    </div>
  );
}
