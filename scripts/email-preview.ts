/**
 * Rend chaque gabarit transactionnel dans `tmp/email-preview/`, en français et
 * en anglais, pour qu'on puisse le REGARDER avant de l'envoyer.
 *
 * Un e-mail ne se relit pas dans un test : le test prouve qu'une capsule est
 * là, pas qu'elle est belle. Ce script ouvre le seul chemin honnête, un
 * fichier HTML dans un navigateur, et n'envoie rien à personne. Les données
 * sont un ÉCHANTILLON, pas une capture : aucun compte, aucun runtime réel.
 *
 *   make email-preview
 */
import { TRANSACTIONAL_EMAIL_KINDS } from "@openedbot/contracts-api";
import { TRANSACTIONAL_EMAIL_SAMPLE_DATA } from "@openedbot/notifications/domain/email/samples";
import { renderTransactionalEmail } from "@openedbot/notifications/domain/email/templates";

const directory = "tmp/email-preview";
const written: string[] = [];

for (const kind of TRANSACTIONAL_EMAIL_KINDS) {
  for (const locale of ["fr", "en"] as const) {
    const rendered = renderTransactionalEmail({
      kind,
      locale,
      data: TRANSACTIONAL_EMAIL_SAMPLE_DATA[kind],
    });
    const path = `${directory}/${kind}.${locale}.html`;
    await Bun.write(path, rendered.html);
    await Bun.write(`${directory}/${kind}.${locale}.txt`, `${rendered.subject}\n\n${rendered.text}\n`);
    written.push(`${path}  ${rendered.subject}`);
  }
}

console.log(`${written.length} gabarits rendus dans ${directory}/ :`);
for (const line of written) console.log(`  ${line}`);
console.log("\nOuvrez un .html dans un navigateur ; le .txt à côté est la version sans HTML.");
console.log("Fond blanc, sans mode sombre : le client a interdiction de l’inverser.");
