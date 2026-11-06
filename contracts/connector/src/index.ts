/**
 * Le contrat du connecteur pour le reste du dépôt. La source fait foi dans
 * `protocol/connector` (`@openedbot/protocol-connector`), publiable seule ;
 * ce paquet la réexporte sans copie, sous le nom que le dépôt et les plug-ins
 * importent déjà.
 */
export * from "@openedbot/protocol-connector";
