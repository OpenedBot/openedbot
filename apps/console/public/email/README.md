# Images des e-mails transactionnels

`public/` et non `src/assets/` : Vite copie ce dossier VERBATIM dans `dist/`,
sans empreinte dans le nom. Une image d'e-mail doit garder son URL pour
toujours, puisqu'elle vit dans des boîtes de réception que personne ne
redéploie ; un nom haché changerait à chaque construction et casserait tous
les messages déjà envoyés.

`waitlist-banner.jpg` n'est plus posé par aucun gabarit depuis l'effacement
de la liste d'attente (migration 0180, plan 0005) ; il reste servi pour les
messages déjà reçus, qui l'affichent encore.

| Fichier | Servi à | Affiché | Source |
| --- | --- | --- | --- |
| `waitlist-banner.jpg` | `https://openedbot.app/email/waitlist-banner.jpg` | 440 x 213 | `assets/waitlist/moon-light-1680.webp` (retiré du dépôt ; voir `git show a9b2c3dc:apps/console/public/assets/waitlist/moon-light-1680.webp`) |
| `openedbot-mark.png` | `https://openedbot.app/email/openedbot-mark.png` | 40 x 40 | `brand/openedbot-bloub.svg` (le bloub), 132 x 132 PNG (sharp, `resize(132,132).png()`) |

## Pourquoi ce fichier-là, et pas l'artwork tel quel

- **JPEG, pas WebP.** Outlook pour Windows rend le HTML avec le moteur de Word
  et ne connaît pas WebP : il afficherait un cadre vide. Les artworks WebP
  d'origine (`assets/waitlist/`, retirés du dépôt) ne servaient que le navigateur.
- **Le jeu CLAIR.** L'e-mail est une lettre sur fond blanc ; le jeu sombre y
  poserait un pavé noir. Le jeu clair fond déjà vers `#ebeef8` en bas.
- **Un fondu prolongé jusqu'au blanc pur.** Sans lui, `#ebeef8` posé sur du
  `#ffffff` laisse une couture visible en travers du message. Le dégradé part
  de 50 % de la hauteur et finit opaque : l'image se dissout dans la page.
- **1200 x 580 pour 600 x 290 affichés**, donc le double, pour les écrans à
  forte densité. Sous 100 Ko : un e-mail se télécharge parfois en itinérance.

## Refabriquer

`sharp` n'est pas une dépendance d'openedbot, la conversion se fait hors dépôt.

```bash
mkdir -p /tmp/openedbot-email-img && cd /tmp/openedbot-email-img && bun init -y && bun add sharp
bun -e '
import sharp from "sharp";
// Source retirée du dépôt : git show a9b2c3dc:apps/console/public/assets/waitlist/moon-light-1680.webp > moon-light-1680.webp
const src = "moon-light-1680.webp";
const W = 1200, H = 580;
const fade = Buffer.from(
  `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
     <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
       <stop offset="0.8" stop-color="#ffffff" stop-opacity="0.75"/>
       <stop offset="1" stop-color="#ffffff" stop-opacity="1"/>
     </linearGradient></defs>
     <rect width="${W}" height="${H}" fill="url(#f)"/>
   </svg>`);
await sharp(src).resize(W, H, { fit: "cover", position: "top" })
  .composite([{ input: fade, blend: "over" }])
  .flatten({ background: "#ffffff" })
  .jpeg({ quality: 86, chromaSubsampling: "4:4:4", mozjpeg: true })
  .toFile("waitlist-banner.jpg");
'
```
