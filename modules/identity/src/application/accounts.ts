/**
 * Accounts and organizations as other packages see them: the
 * API's auth and workspace routes and the plug-ins read and create them
 * through this file, never through `../sql/accounts`.
 */
export {
  type ApiEnvironment,
  createOrganization,
  firstLivingOrganization,
  recordUserLogin,
  verifyCredentials,
} from "../sql/accounts";
