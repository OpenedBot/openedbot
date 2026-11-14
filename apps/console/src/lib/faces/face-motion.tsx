import { createContext, useContext, type ReactNode } from "react";

/**
 * Does a face move, here?
 *
 * The default answer is yes, that is the reference app's contract, whose avatar
 * animates everywhere and exposes only opt-outs (`paused`, `isStatic`). A bot
 * frozen in a list looks like an icon; a bot that breathes looks like
 * someone.
 *
 * The exception is set per subtree, not per caller: settings
 * (`/settings` and all its sections) are a form screen, where thirty
 * faces breathing while one fills a field are noise. It is
 * the route frame that declares it, once, and not each `BotFace` that
 * tests the URL.
 */
const FaceMotionContext = createContext(true);

export function FaceMotionProvider({ anime, children }: { anime: boolean; children: ReactNode }) {
  return <FaceMotionContext.Provider value={anime}>{children}</FaceMotionContext.Provider>;
}

/** `true` when the faces of this subtree are allowed to live. */
export function useFaceMotion(): boolean {
  return useContext(FaceMotionContext);
}
