import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import { verifyEmailLoginCode } from "@openedbot/identity/application/email-login-code";
import { issueNativeAuthCode } from "@openedbot/identity/application/native-auth";
import type { ApiConfig } from "../../infrastructure/config";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { waitlistEnabled, type ProductFeatureSource } from "../../application/product-features";
import { loginEmail, type AppVariables } from "./auth";

/**
 * Connexion native par code e-mail seul : la porte sans mot de passe du
 * desktop, monté sous `/api/auth/native/code` (donc sans session).
 *
 * Le code se demande par `POST /api/auth/login/code`, comme sur le web. Sa
 * vérification est celle de `/login/code/verify` (mêmes erreurs, même liste
 * d'attente, même création de compte), mais la fin diffère : au lieu d'un
 * cookie, un code d'autorisation lié au challenge PKCE, que le client échange
 * par `/native/token`, comme après `/native/authorize`.
 *
 * Pas de `recordUserLogin` ici : `exchangeNativeAuthCode` date l'entrée à
 * l'échange, et le dater aussi à l'émission compterait deux fois la même
 * connexion. Pas de garde `passwordOpen` non plus : aucun mot de passe en jeu.
 *
 * Vit hors de `auth.ts`, qui est à son plafond de taille (cliquet 600 lignes).
 */
export function nativeCodeLoginRoutes(
  db: Db,
  config: Pick<ApiConfig, "nativeRedirectUris">,
  agencyFeature: ProductFeatureSource = false,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  // Même garde que `authRoutes` : la réponse porte un code one-shot.
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Pragma", "no-cache");
    context.header("Referrer-Policy", "no-referrer");
    await next();
  });

  routes.post("/verify", async (context) => {
    const body = await jsonBody(context.req.raw);
    const email = loginEmail(body.email);
    const emailCode = assertString(body.code, "Le code", { max: 16 });
    const codeChallenge = assertString(body.codeChallenge, "Le challenge PKCE", { min: 43, max: 128 });
    const redirectUri = assertString(body.redirectUri, "L’URI de retour", { max: 1_024 });
    const clientId = assertString(body.clientId, "Le client", { max: 100 });
    // Refusée avant de toucher au code : une URI hors liste ne brûle pas d'essai.
    if (!config.nativeRedirectUris.includes(redirectUri)) {
      throw new HttpError(400, "REDIRECT_URI_INVALID", "Cette URI de retour n’est pas autorisée.");
    }
    const member = await verifyEmailLoginCode(db, {
      email,
      code: emailCode,
      waitlistRequired: await waitlistEnabled(agencyFeature),
    });
    // Un compte sans organisation (neuf, ou dont l'espace a disparu) reçoit
    // quand même son code, comme sa session web : il définit son organisation
    // dans l'onboarding de la console, dans la fenêtre du desktop (0158).
    const code = await issueNativeAuthCode(db, {
      organizationId: member.organizationId,
      userId: member.userId,
      codeChallenge,
      redirectUri,
      clientId,
    });
    return context.json({ code, redirectUri });
  });

  return routes;
}
