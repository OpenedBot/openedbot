/**
 * Desktop: the bar's card, the one from the « Chat Starter » template (grey,
 * radius 24, hairline `border-button-white`, no shadow). It holds everything except
 * the 46 px head, which stays on the frame background with the top bar.
 *
 * Leaf module: the conversations bar AND the settings menu in page
 * mode both wear it, without either importing the other (an import cycle otherwise).
 */
export const BOARD_SIDEBAR_CARD =
  "flex min-h-0 flex-1 flex-col rounded-3xl border border-border-button-white bg-background-secondary-default p-[7px]";
