/**
 * Le chemin de la montée WebSocket du lien connecteur. Déclaré ici, sans
 * dépendance, pour que l'infrastructure (preuve de possession) et la route
 * HTTP le partagent sans cycle d'import.
 */
export const RUNTIME_LINK_WS_PATH = "/api/runtime-links/ws";
