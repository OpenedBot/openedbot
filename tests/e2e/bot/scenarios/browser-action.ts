import type { BotComputerDto, MessageContent } from '@openedbot/contracts-api';
import type { Scenario, ScenarioContext } from '../kit/scenario';
import { capabilities, invariant, noTools, poll, toolset } from '../kit/p1-evidence';
import { LabBrowserFixture, executeBrowserCommand, browserSidecarDetail } from '../kit/lab-browser-fixture';
import { ToolFixture, type BrowserFixturePage } from '../kit/tool-fixture';
import { requireCompleted, successfulTool, toolBot, toolEvents, type ToolEvent } from '../kit/tool-proof';

/**
 * This is deliberately a hard acceptance gate. The current public Computer
 * contract only has `unavailable`; a native gateway browser, viewer screenshot
 * or compatible transport cannot attest an action on this bot's Box.
 * Replace this gate with an action/receipt test when the product exposes an
 * attested run-scoped controller binding, never with an upstream browser call.
 */
export function requireBrowserBinding(computer: BotComputerDto, botId: string): never {
  if (computer.botId !== botId) throw new Error('Computer evidence belongs to another bot.');
  if (computer.agentControl?.status !== 'unavailable') throw new Error('Computer agent-control contract changed: implement and verify run-scoped action receipts before accepting browser-action.');
  throw new Error(`BROWSER_ACTION_UNPROVEN: ${computer.agentControl.reason}. The bot's Box has no attested run-scoped browser controller; a gateway-host browser is not an acceptable substitute.`);
}

/** Runtime browsing proves this fixture's effect, never control of the bot's Box. */
export function proveRuntimeBrowserAction(events: readonly ToolEvent[], output: string, page: BrowserFixturePage, botId: string, runId: string): number {
  invariant(page.botId === botId && page.runId === runId, 'Browser fixture belongs to another bot or run.');
  invariant(page.loads > 0 && page.bootstraps > 0 && page.interactions > 0, 'The fixture has no loaded JavaScript page and input interaction.');
  const [submission] = page.submissions;
  invariant(page.submissions.length === 1 && submission?.botId === botId && submission.runId === runId
    && submission.value === page.value && submission.receipt === page.receipt, 'No unique exact-run browser submission was independently recorded.');
  invariant(!events.some((event) => event.type === 'tool.call' && !['browser_exec', 'tool_search'].includes(String(event.payload.tool))),
    'An unapproved non-browser action outside browser_exec or read-only tool discovery was called.');
  const calls = successfulTool(events, 'browser_exec', page.receipt);
  invariant(output.includes(page.value) && output.includes(page.receipt), 'The bot did not return the hidden DOM code and submitted receipt.');
  return calls;
}

async function screenshotEvidence(context: ScenarioContext, threadId: string, runId: string): Promise<{ screenshotAttachments: number; screenshotBytes: number }> {
  const thread = await context.session.api<{ messages: Array<{ role: string; runId: string | null; content: MessageContent }> }>(
    'GET', `/api/threads/${threadId}`);
  const images = thread.messages.filter((message) => message.runId === runId && message.role === 'assistant')
    .flatMap((message) => message.content).filter((part) => part.type === 'attachment' && part.kind === 'image');
  let total = 0;
  for (const image of images) {
    if (image.type !== 'attachment') continue;
    invariant(image.id && image.bytes > 0 && image.bytes <= 8 * 1024 * 1024, 'Screenshot attachment metadata is invalid.');
    const response = await context.session.raw('GET', `/api/attachments/${image.id}`);
    invariant(response.ok, 'Screenshot independent readback failed.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    invariant(bytes.length === image.bytes && (png || jpeg), 'Screenshot is not a bounded PNG/JPEG matching persisted metadata.');
    total += bytes.length;
  }
  return { screenshotAttachments: images.length, screenshotBytes: total };
}

export const browserAction: Scenario = {
  id: 'browser-action',
  title: 'Navigateur Hermes : formulaire et effet vérifié',
  summary: 'Le navigateur du runtime lit un code construit par JavaScript, remplit un formulaire et produit un reçu serveur lié au bot et au run ; cela ne prouve pas le pilotage de la Box.',
  async run(context) {
    const { session, lab, config, rec } = context;
    const target = ('browserTarget' in config ? config.browserTarget : undefined) ?? 'runtime';
    invariant(target === 'runtime' || target === 'computer', 'Unknown browser acceptance target.');
    const bot = await toolBot(context, 'E2E Navigateur', ['browser', 'terminal']);
    if (target === 'computer') {
      await rec.step('Le Computer du bot atteste son contrôleur d’action', async () => {
        requireBrowserBinding(await session.api<BotComputerDto>('GET', `/api/bots/${bot.id}/computer`), bot.id);
      });
      return;
    }
    let fixture: ToolFixture | undefined;
    let labFixture: LabBrowserFixture | undefined;
    try {
      if (config.browserFixtureCommand) {
        await rec.step('Exception URL privée explicite sur le seul profil E2E', async () => {
          invariant(config.exclusiveRuntime && config.expectedRuntimeId === session.runtime.id
            && session.runtime.reachability === 'connector', 'Lab browser fixture requires the explicit matching exclusive connector runtime.');
          invariant(bot.hermesProfileManaged && bot.hermesProfile, 'Lab browser fixture requires a managed owned E2E profile.');
          const identity = { runtimeId: session.runtime.id, nonce: crypto.randomUUID(), profile: bot.hermesProfile };
          labFixture = new LabBrowserFixture(identity, (action) => executeBrowserCommand(config.browserFixtureCommand!, identity, action));
          const evidence = await labFixture.setup();
          return { ...identity, profileOnly: true, privateUrlException: true, publicPublishing: false,
            backend: evidence.backend, version: evidence.version, archiveSha256: evidence.archiveSha256,
            artifactTarget: evidence.target, ...browserSidecarDetail(evidence), setupReconciled: labFixture.setupReconciled };
        });
      }
      await rec.step('Navigateur Hermes et prérequis terminal disponibles', async () => {
        await noTools(session, bot);
        // Hermes 0.23 removes browser_exec from sessions lacking terminal.
        // Its presence is required; direct terminal actions still fail below.
        await toolset(session, bot, 'terminal', true);
        await toolset(session, bot, 'browser', true);
        const inventory = await capabilities(session, bot);
        const browser = inventory.toolsets?.find((entry) => entry.name === 'browser' && entry.enabled);
        invariant(browser?.configured && browser.available !== false && browser.tools.includes('browser_exec'),
          'This profile has no configured browser_exec runtime tool.');
        invariant(inventory.toolsets?.every((entry) => !entry.enabled || ['browser', 'terminal'].includes(entry.name))
          && (inventory.mcpServers ?? []).every((entry) => !entry.enabled),
          `An unrelated toolset or MCP remains enabled: ${JSON.stringify({
            toolsets: inventory.toolsets?.filter((entry) => entry.enabled).map((entry) => entry.name),
            mcp: (inventory.mcpServers ?? []).filter((entry) => entry.enabled).map((entry) => entry.name),
          })}`);
        fixture = ToolFixture.start(config);
        return { target: 'hermes-runtime-browser', provesBoxControl: false, terminalPrerequisite: true, fixtureOrigin: fixture.origin };
      });
      invariant(fixture, 'Browser fixture was not started.');
      const page = fixture.browserPage(bot.id);
      let runId = '';
      await rec.step('Navigation, lecture DOM, saisie et clic de formulaire', async () => {
        const t0 = Date.now();
        const admitted = await session.api<{ runId: string }>('POST', `/api/threads/${bot.threadId}/messages`, {
          input: [
            'Execute this controlled browser test. Use browser_exec and its browser DOM interaction helpers. You may use tool_search to discover browser_exec.',
            'The terminal toolset is enabled only because Hermes requires it to expose browser_exec. Never call terminal, process, execute_code or another action tool directly.',
            `Navigate to ${page.url}. Wait until JavaScript replaces Loading with the validation code.`,
            'Inspect the DOM, read the code, type it into the Validation code input, wait for Submit validation to become enabled, then click it once.',
            'Use real browser typing/clicking. Do not issue raw HTTP requests or call fetch/requests/urllib to bypass the form.',
            'Read the Submitted confirmation from the DOM. Make the final browser_exec call print only the validation code and BROWSER_RECEIPT value so both appear in its result.',
            'If the browser supports screenshots, capture the submitted confirmation and return it as an image attachment using MEDIA: followed by the screenshot path.',
            'In your final answer return the validation code and receipt. Do not claim to have controlled an openedbot Box: this is the Hermes runtime browser.',
          ].join('\n'),
        }, 202);
        runId = admitted.runId;
        page.bindRun(runId);
        const turn = await lab.follow(runId, t0);
        requireCompleted(turn);
        const calls = proveRuntimeBrowserAction(await toolEvents(context, runId), turn.run?.output ?? '', page, bot.id, runId);
        return { runId, browserCalls: calls, pageLoads: page.loads, jsBootstraps: page.bootstraps, inputInteractions: page.interactions,
          submittedEffects: page.submissions.length, exactRunBinding: true, provesBoxControl: false };
      });
      await rec.step('Capture livrée : relecture indépendante si présente', async () => {
        const evidence = await screenshotEvidence(context, bot.threadId, runId);
        return { ...evidence, screenshotVerified: evidence.screenshotAttachments > 0,
          screenshotStatus: evidence.screenshotAttachments > 0 ? 'delivered-and-verified' : 'not-delivered; action proof comes from the server receipt' };
      });
    } finally {
      try {
        if (labFixture) {
          await session.api('POST', `/api/threads/${bot.threadId}/stop`, undefined, 204);
          await poll(() => session.api<{ runs: Array<{ status: string }> }>('GET', `/api/threads/${bot.threadId}`),
            (thread) => thread.runs.every((run) => ['completed', 'failed', 'cancelled'].includes(run.status)),
            config.runTimeoutMs, 'Owned browser thread settlement before restoring profile');
          await rec.step('Restauration des seuls champs navigateur possédés', async () => {
            const evidence = await labFixture!.cleanup();
            invariant(evidence?.removed && evidence.configRestored && !evidence.privateUrlException, 'Owned browser fixture restoration has no complete evidence.');
            return { profileOnly: true, ownedExceptionRemoved: true, configRestored: evidence.configRestored,
              ...browserSidecarDetail(evidence) };
          });
        }
      } finally { await fixture?.stop(); }
    }
  },
};
