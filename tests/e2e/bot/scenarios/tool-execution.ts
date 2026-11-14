import { ToolFixture, pdfWriterScript, type ToolFixtureConfig } from '../kit/tool-fixture';
import { removeFixtureFiles, requireCompleted, successfulTool, toolBot, toolEvents, verifyPdf } from '../kit/tool-proof';
import type { Scenario } from '../kit/scenario';
import type { BotDto } from '@openedbot/contracts-api';

export const toolExecution: Scenario = {
  id: 'tool-execution',
  title: 'Action réelle : lire, modifier et livrer un fichier',
  summary: 'Un nonce absent du prompt traverse les outils terminal/fichier, devient un PDF et est vérifié par téléchargement indépendant.',
  async run(context) {
    const { lab, config, rec } = context;
    let fixture: ToolFixture | undefined;
    let bot: BotDto | undefined;
    let started = false;
    const sourcePath = `/workspace/e2e-source-${lab.tag}.txt`;
    const filename = `e2e-proof-${lab.tag}.pdf`;
    try {
      await rec.step('Fixture contrôlée et profil outillé', async () => {
        fixture = ToolFixture.start(config as typeof config & ToolFixtureConfig);
        return { origin: fixture.origin, listener: fixture.port };
      });
      if (!fixture) throw new Error('The controlled fixture did not start.');
      const source = fixture.source();
      const created = await toolBot(context, 'E2E Fichier', ['terminal', 'file']);
      bot = created;
      let runId = '';
      await rec.step('Le bot exécute les outils demandés', async () => {
        started = true;
        const turn = await lab.send(created.threadId, [
          'Execute this disposable test; do not explain a procedure or invent the result.',
          `1. Use terminal to download ${source.url} to ${sourcePath}. Do not print its contents in terminal.`,
          `2. Use read_file to read ${sourcePath}. Its value is not in this prompt.`,
          `3. Use write_file to replace that exact file with its uppercase content (one line).`,
          `4. Use terminal to execute this Python 3 script exactly, creating /workspace/${filename}:`,
          pdfWriterScript(sourcePath, `/workspace/${filename}`),
          `5. Reply with MEDIA:/workspace/${filename} alone on its own line.`,
          'Do not touch any other file or schedule any background task.',
        ].join('\n'));
        requireCompleted(turn);
        runId = turn.runId;
        const events = await toolEvents(context, runId);
        const terminal = successfulTool(events, 'terminal');
        const reads = successfulTool(events, 'read_file', source.value);
        const writes = successfulTool(events, 'write_file');
        if (source.reads < 1) throw new Error('The runtime never fetched the hidden fixture source.');
        return { runId, terminal, reads, writes, fixtureReads: source.reads };
      });
      await rec.step('Le PDF livré contient la transformation exacte', async () => ({
        bytes: await verifyPdf(context, created.threadId, runId, filename, source.value.toUpperCase()),
        independentReadback: true,
      }));
    } finally {
      try {
        if (bot && started) {
          const owned = bot;
          await rec.step('Les fichiers exacts de la fixture sont supprimés', async () => {
            await removeFixtureFiles(context, owned, [sourcePath, `/workspace/${filename}`]);
            return { files: 2, removed: true };
          });
        }
      } finally { await fixture?.stop(); }
    }
  },
};
