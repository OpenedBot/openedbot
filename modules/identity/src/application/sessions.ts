/**
 * The session store as other packages see it: the API's auth
 * routes and the plug-ins create, find and scope sessions through this file,
 * never through `../sql/sessions`, which stays private to identity.
 */
export {
  attachSessionOrganization,
  createWebSession,
  findLiveSession,
  revokeSessionOnLogout,
  touchSession,
  WEB_SESSION_TTL_MS,
  type SessionDevice,
} from "../sql/sessions";
