import type { BotCapabilitiesDto, BotDto, BotRuntimeMemoryDto } from '@openedbot/contracts-api';
import type { Scenario } from '../kit/scenario';
import { ToolFixture, pdfWriterScript, type ToolFixtureConfig } from '../kit/tool-fixture';
import { assertIsolatedMemory, removeFixtureFiles, requireCompleted, successfulTool, toolBot, toolEvents, verifyPdf } from '../kit/tool-proof';

export const profileIsolation: Scenario = {
  id: 'profile-isolation',
  title: 'Deux profils : fichiers, mémoire et skills cloisonnés',
  summary: 'Deux bots gardent chacun leur mémoire et leurs skills ; le même chemin absolu ne révèle jamais le fichier de leur voisin.',
  async run(context) {
    const { lab, session, rec, config } = context;
    let fixture: ToolFixture | undefined;
    let bots: BotDto[] = [];
    let fileStarted = false;
    const path = `/workspace/e2e-isolation-${lab.tag}.txt`;
    const filename = `e2e-isolation-${lab.tag}.pdf`;
    try {
      fixture = ToolFixture.start(config as typeof config & ToolFixtureConfig);
      bots = await Promise.all(['A', 'B'].map((name) => toolBot(context, `E2E Isolation ${name}`, ['terminal', 'file', 'memory', 'skills'])));
      const [a, b] = bots;
      if (!a || !b || a.hermesProfile === b.hermesProfile) throw new Error('Two distinct managed profiles are required.');
      const sources = [fixture.source(), fixture.source()];
      const [sourceA, sourceB] = sources;
      if (!sourceA || !sourceB) throw new Error('Two independent fixture sources are required.');
      const memory = (botId: string) => session.api<BotRuntimeMemoryDto>('GET', `/api/bots/${botId}/runtime-memory`);
      await rec.step('Les mémoires sont distinctes, relues sur les deux profils', async () => {
        if (!session.hasFeature('profile_memory')) throw new Error('Required host feature profile_memory is absent.');
        for (const [bot, source] of [[a, sourceA], [b, sourceB]] as const) {
          await session.api('POST', `/api/bots/${bot.id}/runtime-memory`, { target: 'memory', action: 'add', content: `E2E_PRIVATE_VALUE=${source.value}` });
        }
        const [ma, mb] = await Promise.all([memory(a.id), memory(b.id)]);
        if (!ma.available || !mb.available) throw new Error('Both profile memory stores must be available.');
        if (ma.profile !== a.hermesProfile || mb.profile !== b.hermesProfile) throw new Error('Memory readback named the wrong profile.');
        assertIsolatedMemory([...ma.entries.memory, ...ma.entries.user], [...mb.entries.memory, ...mb.entries.user], sourceA.value, sourceB.value);
        return { profiles: 2, crossLeak: false };
      });
      await rec.step('Une skill basculée sur A ne modifie pas B', async () => {
        const read = (id: string) => session.api<BotCapabilitiesDto>('GET', `/api/bots/${id}/capabilities`);
        const [ca, cb] = await Promise.all([read(a.id), read(b.id)]);
        if (ca.scope !== 'profile' || cb.scope !== 'profile') throw new Error('Both capability inventories must be profile-scoped.');
        const skill = ca.skills?.find((candidate) => candidate.name !== 'hermes-agent' && candidate.writable && cb.skills?.some((other) => other.name === candidate.name && other.writable));
        if (!skill) throw new Error('No shared writable skill is available to test per-profile isolation.');
        for (const [bot, enabled] of [[a, false], [b, true]] as const) {
          const mutation = await session.api<{ applied: boolean; enabled: boolean }>('POST', `/api/bots/${bot.id}/capabilities/skills/${skill.name}`, { enabled });
          if (!mutation.applied || mutation.enabled !== enabled) throw new Error('The per-profile skill flag was not applied.');
        }
        const [afterA, afterB] = await Promise.all([read(a.id), read(b.id)]);
        if (afterA.skills?.find((entry) => entry.name === skill.name)?.enabled !== false || afterB.skills?.find((entry) => entry.name === skill.name)?.enabled !== true) throw new Error('The skill flag leaked between profiles.');
        return { skill: skill.name, aEnabled: false, bEnabled: true };
      });
      // The same absolute path probes the sandbox mount, even if profiles have
      // different default working directories. Unique filenames would hide sharing.
      await rec.step('A crée son fichier ; B ne peut pas le lire', async () => {
        fileStarted = true;
        const created = await lab.send(a.threadId, `Use terminal to download ${sourceA.url} to the file ${path}. Do not copy it elsewhere. Then use read_file to read ${path}. Reply DONE.`);
        requireCompleted(created);
        successfulTool(await toolEvents(context, created.runId), 'read_file', sourceA.value);
        const absent = await lab.send(b.threadId, `Use terminal to run exactly: python3 -c "from pathlib import Path; p=Path('${path}'); print('E2E_FOREIGN_FILE_PRESENT:' + p.read_text() if p.exists() else 'E2E_FOREIGN_FILE_ABSENT')". Do not create or remove anything. Reply with the tool result.`);
        requireCompleted(absent);
        const events = await toolEvents(context, absent.runId);
        successfulTool(events, 'terminal', 'E2E_FOREIGN_FILE_ABSENT');
        if (JSON.stringify(events).includes(sourceA.value) || absent.run?.output?.includes(sourceA.value)) throw new Error('Bot B read bot A\'s private file value.');
        if (!sourceA.reads) throw new Error('Bot A never retrieved its hidden file source.');
        return { aRunId: created.runId, bRunId: absent.runId, foreignFileAbsent: true };
      });
      await rec.step('B écrit au même chemin ; le fichier de A reste intact', async () => {
        const created = await lab.send(b.threadId, `Use terminal to download ${sourceB.url} to the file ${path}. Then use read_file to read ${path}. Reply DONE.`);
        requireCompleted(created);
        successfulTool(await toolEvents(context, created.runId), 'read_file', sourceB.value);
        const reread = await lab.send(a.threadId, `Use read_file to read the existing file ${path}. Reply with its exact content. Do not write anything.`);
        requireCompleted(reread);
        successfulTool(await toolEvents(context, reread.runId), 'read_file', sourceA.value);
        if (reread.run?.output?.includes(sourceB.value)) throw new Error('Bot A read bot B\'s file value.');
        if (!sourceB.reads) throw new Error('Bot B never retrieved its hidden file source.');
        return { bRunId: created.runId, aRunId: reread.runId, sameAbsolutePath: true };
      });
      await rec.step('Les deux effets restent téléchargeables indépendamment', async () => {
        let bytes = 0;
        for (const [index, bot] of bots.entries()) {
          const source = sources[index];
          if (!source) throw new Error('Missing profile fixture source.');
          const ownFilename = `${index}-${filename}`;
          const turn = await lab.send(bot.threadId, `Generate a test PDF from the synthetic fixture created earlier in this disposable profile's own /workspace. Use read_file to read ${path}; use write_file to replace it with uppercase text. Then use terminal to execute this exact Python script:\n${pdfWriterScript(path, `/workspace/${ownFilename}`)}\nReply with MEDIA:/workspace/${ownFilename} alone on its own line.`);
          requireCompleted(turn);
          bytes += await verifyPdf(context, bot.threadId, turn.runId, ownFilename, source.value.toUpperCase());
        }
        return { artifacts: 2, bytes };
      });
    } finally {
      try {
        if (fileStarted) await rec.step('Les fichiers de test des deux profils sont supprimés', async () => {
          const results = await Promise.allSettled(bots.map((bot, index) => removeFixtureFiles(context, bot, [path, `/workspace/${index}-${filename}`])));
          const failures = results.filter((result) => result.status === 'rejected');
          if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Profile fixture file cleanup failed.');
          return { profiles: bots.length, removed: true };
        });
      } finally { await fixture?.stop(); }
    }
  },
};
