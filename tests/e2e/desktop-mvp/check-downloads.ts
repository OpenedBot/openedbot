import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, mkdir, copyFile } from "node:fs/promises";

const artifacts = "tmp/e2e-desktop-mvp";
const fixture = (await Bun.file(`${artifacts}/fixture.json`).json()) as {
  botId: string;
  threadId: string;
  organizationId: string;
};
const directory = process.env.E2E_DOWNLOADS_DIR ?? join(homedir(), "Downloads");
const names = await readdir(directory);
const conversations = names.filter(
  (name) =>
    name.startsWith(`conversation-${fixture.threadId}`) && name.endsWith(".md"),
);
const bots = names.filter(
  (name) => name.startsWith(`bot-${fixture.botId}`) && name.endsWith(".json"),
);
assert.ok(conversations.length > 0, "No downloaded conversation export");
assert.ok(bots.length > 0, "No downloaded bot export");
for (const name of conversations) {
  const content = await Bun.file(join(directory, name)).text();
  assert.ok(content.includes("Rapport de recette disponible."));
  assert.ok(content.includes("Attachment:"));
}
for (const name of bots) {
  const content = await Bun.file(join(directory, name)).json();
  assert.equal(content.format, "openedbot.bot");
  assert.equal(content.version, 1);
  assert.equal(content.bot.name, "MVP bot");
  assert.equal(content.bot.instructions, "Aide-moi à tester.");
  assert.ok(Number.isSafeInteger(Number(content.bot.tokenBudget)));
  assert.ok(
    !Object.keys(content.bot).some((key) =>
      key.toLowerCase().endsWith("token"),
    ),
  );
  for (const forbidden of ["credential", "secret", "password", "apiKey"]) {
    assert.ok(
      !Object.keys(content.bot).some((key) =>
        key.toLowerCase().includes(forbidden.toLowerCase()),
      ),
    );
  }
}
const downloaded = Bun.file(join(directory, "rapport-mvp.txt"));
assert.equal(await downloaded.text(), "Rapport de recette MVP.\n");
const hash = new Bun.CryptoHasher("sha256")
  .update(await downloaded.arrayBuffer())
  .digest("hex");
const source = join(artifacts, "blobs", "org", fixture.organizationId);
const sourceNames = await readdir(source);
assert.ok(
  await Promise.all(
    sourceNames.map(async (name) =>
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(join(source, name)).arrayBuffer())
        .digest("hex"),
    ),
  ).then((hashes) => hashes.includes(hash)),
);
await mkdir(`${artifacts}/downloads`, { recursive: true });
for (const name of [...conversations, ...bots, "rapport-mvp.txt"])
  await copyFile(join(directory, name), join(artifacts, "downloads", name));
console.info(
  JSON.stringify({
    downloadChecks: "PASS",
    conversations: conversations.length,
    bots: bots.length,
    attachmentSha256: hash,
  }),
);
