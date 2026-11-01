import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import templates from "virtual:ohb-templates";
import { Preview } from "../components/Preview";
import { themesOf, useControls } from "../lib/controls";

/** Two to four templates under the same theme, language, state and size. */
export function Compare() {
  const [controls] = useControls();
  const [params] = useSearchParams();
  const [width, setWidth] = useState(() => window.innerWidth - 64);
  const names = (params.get("names") ?? "")
    .split(",")
    .filter((name) => templates.some((template) => template.name === name))
    .slice(0, 4);
  const themes = themesOf(controls.theme);

  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth - 64);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (names.length < 2) {
    return (
      <p>
        Choisissez 2 à 4 templates dans la <Link to="/">galerie</Link>.
      </p>
    );
  }
  const columns = names.length;
  const query = new URLSearchParams(params);
  query.delete("names");

  return (
    <section>
      <div className="page-head">
        <h1>Comparaison</h1>
      </div>
      <div className="compare" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {names.map((name) => (
          <div key={name} className="compare-column">
            <Link to={`/t/${name}?${query}`} className="compare-name">
              {name}
            </Link>
            {themes.map((theme) => (
              <Preview
                key={theme}
                template={name}
                theme={theme}
                locale={controls.locale}
                state={controls.state}
                width={controls.size.width}
                height={controls.size.height}
                fitWidth={width / columns - 16}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
