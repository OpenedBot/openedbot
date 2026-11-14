/**
 * The header's scenario lab. It opens a controlled box that
 * offers several reproducible requests (approval, ask_user, plan and
 * standard answer) instead of immediately sending a command on click.
 *
 * Development only: this button writes a message into a real thread and
 * consumes a real run: it has no business in a production build.
 * `=== true` because Bun maps
 * `import.meta.env` onto `process.env` (strings) where Vite injects a
 * boolean: an environment `DEV=1` must not open the button.
 *
 * WHAT THE AUTHORIZATION SCENARIO DOES NOT GUARANTEE: openedbot does not administer a client's
 * runtime (its configuration belongs to the host's owner), so it also does not decide what is submitted
 * for approval, it is Hermes that emits `approval.request` according to ITS policy.
 * The text sent (`featureLab.approvalPrompt`) targets `execute_code`, the
 * primitive the connector runtime explicitly proves through the run-scoped
 * approval queue. The program is harmless: a single `print`,
 * with no write and no network. If no gate rises, that is the verdict: the
 * connected runtime does not apply the announced approval contract.
 */
export const SHOW_FEATURE_LAB = import.meta.env.DEV === true;
