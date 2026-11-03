import { SIZES, STATES } from "../lib/preview";
import { useControls } from "../lib/controls";

/** Theme, language, state and window size: the same four questions on every page. */
export function Toolbar() {
  const [controls, update] = useControls();
  return (
    <div className="toolbar" role="group" aria-label="Contrôles d’aperçu">
      <label>
        Thème
        <select value={controls.theme} onChange={(event) => update({ theme: event.target.value })}>
          <option value="dark">Sombre</option>
          <option value="light">Clair</option>
          <option value="both">Les deux</option>
        </select>
      </label>
      <label>
        Langue
        <select value={controls.locale} onChange={(event) => update({ locale: event.target.value })}>
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>
        État
        <select value={controls.state} onChange={(event) => update({ state: event.target.value })}>
          {STATES.map((state) => (
            <option key={state.id} value={state.id}>
              {state.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Fenêtre
        <select value={controls.size.id} onChange={(event) => update({ size: event.target.value })}>
          {SIZES.map((size) => (
            <option key={size.id} value={size.id}>
              {size.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
