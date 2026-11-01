/**
 * Façade : la configuration de l'API vit dans `@openedbot/platform-config/api-config`,
 * parce que la passerelle du lien (apps/link-gateway) la lit aussi sans jamais
 * importer apps/api.
 */
export * from "@openedbot/platform-config/api-config";
