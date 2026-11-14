/**
 * What the API says of a `routine_manage` approval gate
 * (`modules/execution/src/domain/routine-gate-text.ts`): server-side
 * strings, kept out of the console's dictionaries (its first-load chunk),
 * which shows the sentence the API wrote.
 */
export const routineGate = {
  named: "« {name} »",
  unknown: "qu’il ne possède pas (l’outil refusera)",
  list: "Lire la liste de ses routines. Rien n’est modifié.",
  create: "Créer la routine {name} : {schedule}.",
  createOnce: "Créer le rappel unique {name} : {schedule}.",
  update: "Modifier la routine {routine} : {changes}.",
  pause: "Mettre en pause la routine {routine}.",
  resume: "Réactiver la routine {routine}.",
  remove: "Supprimer la routine {routine} et son historique.",
  changeName: "nouveau nom {name}",
  changeSchedule: "planification {schedule}",
  changeTimezone: "fuseau {timezone}",
  changeNothing: "rien ne change",
  changeMessageOnly: "nouveau message",
  changeSeparator: " ; ",
  delay: "une fois, dans {delay} à compter de votre autorisation",
  scheduleUnreadable: "planification illisible « {text} » (l’outil refusera)",
  issueTimezoneMissing: "Aucun fuseau horaire n’est donné : l’outil refusera.",
  issueTimezoneInvalid: "Le fuseau horaire donné n’existe pas : l’outil refusera.",
  issueTooFrequent: "Plus d’un passage toutes les {minutes} minutes : l’outil refusera.",
  issuePastInstant: "Cet instant est déjà passé : l’outil refusera.",
  issueNameTooLong: "Le nom dépasse {nameMax} caractères : l’outil refusera.",
  issueScheduleTooLong: "La planification dépasse 100 caractères : l’outil refusera.",
  issuePromptTooLong: "Le message dépasse {messageMax} caractères : l’outil refusera.",
  message: "Message envoyé au bot à chaque passage : « {message} » ({chars} caractères).",
  messageUnseen: "Message non transmis par le serveur ({chars} caractères) : autoriser, c’est accepter un message que personne n’a pu lire ici.",
  unattendedCreated: "Active dès sa création, en « Ne jamais attendre » : elle s’exécute sans demander d’autorisation.",
  unattended: "En « Ne jamais attendre » : elle s’exécute sans demander d’autorisation.",
  undescribed: "Agir sur ses routines. Le détail de la demande n’a pas pu être lu : refusez si vous n’en êtes pas sûr.",
} as const;
