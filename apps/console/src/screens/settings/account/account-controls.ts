/**
 * ONE height for every control in a form row.
 *
 * An input (`FIELD`, height dictated by its `py`), a `SelectTrigger`
 * (36 px) and a `BUTTON` (32 px) side by side gave three heights for
 * three gestures of the same rank: the row read as an alignment defect.
 * 44 px everywhere: the height of every select in the settings (the
 * `SelectTrigger` default, the Models fields), and on the phone the touch
 * target the shell already imposes (`.openedbot-settings-action`, `mobile.css`).
 */
const CONTROL_DESKTOP = "h-11";
const CONTROL_MOBILE = "h-11 w-full";

export function controlHeight(isMobile: boolean): string {
  return isMobile ? CONTROL_MOBILE : CONTROL_DESKTOP;
}
