/**
 * Le catalogue d'artworks WEBP : l'identité générée d'un bot, partagée.
 *
 * Même logique de partage que `presets.ts` pour les visages vectoriels : le
 * client natif et le web doivent tirer le MÊME artwork du même identifiant, et poser
 * la paupière du clignement au MÊME endroit. Deux copies de la table mesurée
 * finiraient par diverger : elle vit donc ici, et les clients n'apportent que
 * leur rendu (Image + reanimated côté Expo, <img> + CSS côté SPA) et leurs
 * fichiers (`apps/console/public/bots/` côté SPA).
 */

export type BotArtworkMotion = "idle" | "flight" | "orbit" | "jelly" | "sway" | "pulse";

export type BotArtworkSpec = {
  id: string;
  name: string;
  motion: BotArtworkMotion;
  /**
   * Toile peinte jusqu'aux bords : à clipper (coins arrondis). Les mascottes
   * générées ont un champ vide autour du personnage et restent non clippées.
   */
  portrait?: true;
};

const MOTIONS: readonly BotArtworkMotion[] = ["idle", "flight", "orbit", "jelly", "sway", "pulse"];

function motionFor(id: string): BotArtworkMotion {
  const code = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return MOTIONS[code % MOTIONS.length]!;
}

function artwork(id: string, name: string, portrait?: true): BotArtworkSpec {
  return portrait
    ? { id, name, motion: motionFor(id), portrait }
    : { id, name, motion: motionFor(id) };
}

/** The generated WEBP catalogue, with one deterministic motion profile per bot. */
const DEFAULT_BOT_ARTWORKS: readonly BotArtworkSpec[] = [
  artwork("orbit", "Orbit"),
  artwork("comet", "Comète"),
  artwork("prism", "Prisme"),
  artwork("bloom", "Floraison"),
  artwork("wave", "Vague"),
  artwork("ember", "Braise"),
  artwork("jelly", "Gelée"),
  artwork("pixel", "Pixel"),
  artwork("samurai", "Samouraï"),
  artwork("explorer", "Explorateur"),
  artwork("thunder", "Tonnerre"),
  artwork("cloud", "Nuage"),
  artwork("coral", "Corail"),
  artwork("lunar", "Lunaire"),
  artwork("solar", "Solaire"),
  artwork("ink", "Encre"),
  artwork("aurora", "Aurore"),
  artwork("butterfly", "Papillon"),
  artwork("mecha", "Mecha"),
  artwork("music", "Musique"),
  artwork("ocean", "Océan"),
  artwork("cactus", "Cactus"),
  artwork("firefly", "Luciole"),
  artwork("wind", "Vent"),
  artwork("crystal", "Cristal"),
  artwork("retro", "Rétro"),
  artwork("stealth", "Furtif"),
  artwork("confetti", "Confettis"),
  artwork("marshmallow", "Guimauve"),
  artwork("volcano", "Volcan"),
];

/** Keep the default pool stable so existing bots retain their appearance. */
export const BOT_ARTWORKS: readonly BotArtworkSpec[] = [
  ...DEFAULT_BOT_ARTWORKS,
  artwork("astral", "Astral", true),
  artwork("halo", "Halo", true),
  artwork("selene", "Sélène", true),
];

/**
 * Les mascottes qu'on propose au choix et au dé. Les portraits (toiles peintes)
 * restent résolubles pour les bots qui les portent déjà, mais ne se proposent
 * plus (choix de l'opérateur, 2026-10-26).
 */
export const PICKABLE_BOT_ARTWORKS: readonly BotArtworkSpec[] = DEFAULT_BOT_ARTWORKS;

/** Un artwork au hasard : le dé de l'onboarding natif et des dialogues web. */
export function randomBotArtwork(): BotArtworkSpec {
  return PICKABLE_BOT_ARTWORKS[Math.floor(Math.random() * PICKABLE_BOT_ARTWORKS.length)]!;
}

export function resolveBotArtwork(id: string | null | undefined): BotArtworkSpec | null {
  if (!id) return null;
  return BOT_ARTWORKS.find((entry) => entry.id === id) ?? null;
}

/**
 * L'artwork d'un bot qui n'a rien choisi.
 *
 * Même contrat que `defaultFaceFor` : tiré de l'identifiant, donc stable au
 * renommage et entre deux lancements. Le sel évite de recouper le hachage des
 * axes du visage vectoriel.
 */
export function defaultArtworkFor(seed: string): BotArtworkSpec {
  const key = `artwork:${seed}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) >>> 0;
  }
  return DEFAULT_BOT_ARTWORKS[hash % DEFAULT_BOT_ARTWORKS.length]!;
}

/**
 * Où sont les yeux de chaque artwork : mesuré, pas deviné.
 *
 * Les yeux sont peints DANS l'image : pour les faire cligner, on pose une
 * paupière de la couleur du visor par-dessus, et il faut donc savoir, par
 * artwork, où sont les capsules lumineuses et de quel noir est l'écran autour.
 * Un seul gabarit partagé ne marche pas, c'est l'erreur qui a produit les
 * « yeux doublés » de la première tentative : chaque tête est cadrée
 * différemment.
 *
 * Généré par un script d'extraction hors de ce dépôt (détection des
 * capsules dans le visor sombre du WEBP 1024², affiné à la main pour jelly,
 * ink, mecha et stealth). Regénérer plutôt qu'éditer si les WEBP changent.
 *
 * Coordonnées en fractions de l'image carrée : `cx/cy` le centre, `w/h` la
 * boîte de la capsule. `lid` est le noir du visor autour des yeux (la couleur
 * de la paupière), `eye` la couleur médiane de la lueur (libre pour un futur
 * effet : non utilisée par le clignement).
 */

export type BotArtworkEyeBox = {
  cx: number;
  cy: number;
  w: number;
  h: number;
};

export type BotArtworkEyeSpec = {
  /** Le noir du visor : une paupière d'une autre teinte laisserait un halo. */
  lid: string;
  /** La lueur des capsules, médiane. */
  eye: string;
  /** Une boîte par œil ; stealth n'a que deux fentes de visor, jelly des arcs. */
  eyes: readonly BotArtworkEyeBox[];
};

/**
 * La paupière déborde de la capsule mesurée : la lueur dépasse de la boîte, et
 * une paupière trop juste laisserait un liseré allumé pendant le clignement.
 * Partagé pour que les tests et les deux rendus gardent la même marge.
 */
export const BLINK_LID_SCALE_X = 1.35;
export const BLINK_LID_SCALE_Y = 1.4;

export const BOT_ARTWORK_EYES: Record<string, BotArtworkEyeSpec> = {
  aurora: { lid: "#021730", eye: "#6beafd", eyes: [{ cx: 0.4678, cy: 0.5054, w: 0.0479, h: 0.0918 }, { cx: 0.6343, cy: 0.5049, w: 0.0449, h: 0.0908 }] },
  bloom: { lid: "#2e191d", eye: "#fdc1c1", eyes: [{ cx: 0.4106, cy: 0.5151, w: 0.0566, h: 0.1016 }, { cx: 0.5884, cy: 0.5151, w: 0.0566, h: 0.1016 }] },
  butterfly: { lid: "#041722", eye: "#88fbfc", eyes: [{ cx: 0.437, cy: 0.4639, w: 0.0449, h: 0.0693 }, { cx: 0.562, cy: 0.4639, w: 0.0449, h: 0.0693 }] },
  cactus: { lid: "#19141a", eye: "#fda8d8", eyes: [{ cx: 0.374, cy: 0.5317, w: 0.0615, h: 0.1035 }, { cx: 0.5688, cy: 0.5332, w: 0.0625, h: 0.1025 }] },
  cloud: { lid: "#071221", eye: "#9ee6fd", eyes: [{ cx: 0.3193, cy: 0.543, w: 0.0498, h: 0.085 }, { cx: 0.4976, cy: 0.5332, w: 0.0566, h: 0.0869 }] },
  comet: { lid: "#05192f", eye: "#52d4fe", eyes: [{ cx: 0.2378, cy: 0.5493, w: 0.0332, h: 0.0781 }, { cx: 0.396, cy: 0.5415, w: 0.0469, h: 0.084 }] },
  confetti: { lid: "#0c1a27", eye: "#75d2fd", eyes: [{ cx: 0.3462, cy: 0.4902, w: 0.0488, h: 0.0947 }, { cx: 0.5293, cy: 0.4971, w: 0.0557, h: 0.0967 }] },
  coral: { lid: "#0a1b21", eye: "#81faef", eyes: [{ cx: 0.4043, cy: 0.5708, w: 0.0557, h: 0.0996 }, { cx: 0.5942, cy: 0.5708, w: 0.0547, h: 0.0996 }] },
  crystal: { lid: "#010b1d", eye: "#93cbfc", eyes: [{ cx: 0.4062, cy: 0.563, w: 0.0537, h: 0.0918 }, { cx: 0.5869, cy: 0.5635, w: 0.0537, h: 0.0908 }] },
  ember: { lid: "#24170b", eye: "#fdd042", eyes: [{ cx: 0.4126, cy: 0.5356, w: 0.0508, h: 0.0898 }, { cx: 0.584, cy: 0.5356, w: 0.0498, h: 0.0898 }] },
  explorer: { lid: "#092433", eye: "#48f6fd", eyes: [{ cx: 0.3462, cy: 0.521, w: 0.0527, h: 0.1055 }, { cx: 0.5503, cy: 0.521, w: 0.0547, h: 0.1055 }] },
  firefly: { lid: "#181310", eye: "#feec8d", eyes: [{ cx: 0.3608, cy: 0.4619, w: 0.043, h: 0.1006 }, { cx: 0.5093, cy: 0.4658, w: 0.0488, h: 0.1025 }] },
  ink: { lid: "#0f0e14", eye: "#a873fa", eyes: [{ cx: 0.4053, cy: 0.5156, w: 0.0459, h: 0.0947 }, { cx: 0.5854, cy: 0.5166, w: 0.0469, h: 0.0947 }] },
  jelly: { lid: "#0b152a", eye: "#abfbfc", eyes: [{ cx: 0.4048, cy: 0.4917, w: 0.0879, h: 0.043 }, { cx: 0.5952, cy: 0.4927, w: 0.0879, h: 0.0449 }] },
  lunar: { lid: "#0a1325", eye: "#82cdfd", eyes: [{ cx: 0.3687, cy: 0.5405, w: 0.0488, h: 0.0938 }, { cx: 0.5454, cy: 0.54, w: 0.0527, h: 0.0947 }] },
  marshmallow: { lid: "#121025", eye: "#d2b4fc", eyes: [{ cx: 0.4067, cy: 0.4946, w: 0.0625, h: 0.1055 }, { cx: 0.5869, cy: 0.4946, w: 0.0615, h: 0.1055 }] },
  mecha: { lid: "#031424", eye: "#55dcfd", eyes: [{ cx: 0.42, cy: 0.542, w: 0.04, h: 0.07 }, { cx: 0.579, cy: 0.542, w: 0.041, h: 0.07 }] },
  music: { lid: "#071c2f", eye: "#39e8fd", eyes: [{ cx: 0.4077, cy: 0.5698, w: 0.0449, h: 0.1016 }, { cx: 0.5903, cy: 0.5703, w: 0.0449, h: 0.1025 }] },
  ocean: { lid: "#021021", eye: "#4ed7fd", eyes: [{ cx: 0.3325, cy: 0.5244, w: 0.043, h: 0.0928 }, { cx: 0.5005, cy: 0.5225, w: 0.0508, h: 0.0947 }] },
  orbit: { lid: "#021325", eye: "#70c5fd", eyes: [{ cx: 0.4946, cy: 0.4707, w: 0.0566, h: 0.1006 }, { cx: 0.6523, cy: 0.4595, w: 0.0518, h: 0.0996 }] },
  pixel: { lid: "#010d1e", eye: "#16fdfd", eyes: [{ cx: 0.353, cy: 0.5137, w: 0.0527, h: 0.1143 }, { cx: 0.54, cy: 0.5132, w: 0.0537, h: 0.1152 }] },
  prism: { lid: "#020d21", eye: "#03e1fd", eyes: [{ cx: 0.4756, cy: 0.5215, w: 0.0537, h: 0.1064 }, { cx: 0.6367, cy: 0.5352, w: 0.0479, h: 0.1025 }] },
  retro: { lid: "#061831", eye: "#2ee6fd", eyes: [{ cx: 0.4448, cy: 0.5029, w: 0.0449, h: 0.0967 }, { cx: 0.6265, cy: 0.5044, w: 0.043, h: 0.0938 }] },
  samurai: { lid: "#130d0f", eye: "#fb4a47", eyes: [{ cx: 0.4155, cy: 0.5781, w: 0.0449, h: 0.0771 }, { cx: 0.5835, cy: 0.5781, w: 0.0449, h: 0.0771 }] },
  solar: { lid: "#161512", eye: "#feee8c", eyes: [{ cx: 0.4033, cy: 0.5635, w: 0.0537, h: 0.0947 }, { cx: 0.5957, cy: 0.5635, w: 0.0537, h: 0.0947 }] },
  stealth: { lid: "#090203", eye: "#fa635d", eyes: [{ cx: 0.578, cy: 0.49, w: 0.162, h: 0.055 }, { cx: 0.791, cy: 0.487, w: 0.082, h: 0.055 }] },
  thunder: { lid: "#06182b", eye: "#6cdcfd", eyes: [{ cx: 0.3999, cy: 0.6196, w: 0.0469, h: 0.1055 }, { cx: 0.5991, cy: 0.6196, w: 0.0469, h: 0.1055 }] },
  volcano: { lid: "#1f100e", eye: "#fdbd27", eyes: [{ cx: 0.4072, cy: 0.5679, w: 0.0557, h: 0.1016 }, { cx: 0.5913, cy: 0.5674, w: 0.0566, h: 0.1006 }] },
  wave: { lid: "#0a1b21", eye: "#22fafd", eyes: [{ cx: 0.3447, cy: 0.4346, w: 0.0439, h: 0.0889 }, { cx: 0.4946, cy: 0.4019, w: 0.0508, h: 0.0918 }] },
  wind: { lid: "#052138", eye: "#71f9fe", eyes: [{ cx: 0.4448, cy: 0.5259, w: 0.0488, h: 0.084 }, { cx: 0.6187, cy: 0.5215, w: 0.0469, h: 0.083 }] },
};

export function resolveBotArtworkEyes(id: string | null | undefined): BotArtworkEyeSpec | null {
  if (!id) return null;
  return BOT_ARTWORK_EYES[id] ?? null;
}
