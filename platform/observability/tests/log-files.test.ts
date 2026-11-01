import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import pino from "pino";
import { logMixin } from "../src/log/context";
import { createLogFileStream, logFileStem, logsDirectory } from "../src/log/files";
import { logRedact } from "../src/log/redact";

async function tmpLogs(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ohb-logs-"));
}

describe("log files", () => {
  test("le dossier par défaut est apps/api/var/logs", () => {
    expect(logsDirectory().replaceAll("\\", "/")).toMatch(/\/apps\/api\/var\/logs$/);
  });

  test("l'environnement devient le nom Symfony (dev.log, prod.log)", () => {
    expect(logFileStem("development")).toBe("dev");
    expect(logFileStem("production")).toBe("prod");
    expect(logFileStem("test")).toBe("test");
  });

  /**
   * Vu en production le 2026-09-11 : sous Bun 1.4.0, pendant les secondes qui
   * suivent un redémarrage, sonic-boom n'a pas encore son descripteur et son
   * `write` lève « The value of "fd" is out of range ... Received -1 ».
   * L'exception remontait pino, puis le middleware de journalisation, et
   * sortait en 500 sur des routes publiques. Un log perdu est un incident de
   * journal, jamais un incident de requête.
   */
  test("une destination qui lève ne fait pas échouer l'écriture appelante", async () => {
    const dir = await tmpLogs();
    const stderrLines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const stream = createLogFileStream({
        dir,
        env: "dev",
        sync: true,
        createDestination: () => ({
          write() {
            throw new Error('The value of "fd" is out of range. Received -1');
          },
        }),
      });
      expect(() => stream.write('{"channel":"api","msg":"pendant le redémarrage"}\n')).not.toThrow();
    } finally {
      process.stderr.write = realWrite;
    }

    // Le repli est nommé : la panne se lit sur stderr, donc dans journald.
    expect(stderrLines.join("")).toContain("logger: écriture fichier:");
    expect(stderrLines.join("")).toContain("fd");
  });

  test("une ligne part dans le fichier d'environnement et dans celui du canal", async () => {
    const dir = await tmpLogs();
    const stream = createLogFileStream({ dir, env: "dev", sync: true });
    const log = pino({ mixin: logMixin, redact: logRedact, base: undefined }, stream);
    log.info({ event: "staff.waitlist_access_granted", domain: "exemple.test" }, "staff.waitlist_access_granted");

    const names = (await readdir(dir)).sort();
    expect(names).toEqual(["dev.log", "staff.log"]);

    const staff = await readFile(join(dir, "staff.log"), "utf8");
    const all = await readFile(join(dir, "dev.log"), "utf8");
    expect(staff).toBe(all);
    const record = JSON.parse(staff.trim()) as { channel: string; event: string; domain: string };
    expect(record.channel).toBe("staff");
    expect(record.event).toBe("staff.waitlist_access_granted");
    expect(record.domain).toBe("exemple.test");
  });

  test("un skip d'email va dans email.log, pas dans staff.log", async () => {
    const dir = await tmpLogs();
    const stream = createLogFileStream({ dir, env: "dev", sync: true });
    const log = pino({ mixin: logMixin, redact: logRedact, base: undefined }, stream);
    log.warn({ event: "staff.waitlist_access_email_skipped_failed", domain: "exemple.test" }, "staff.waitlist_access_email_skipped_failed");

    const names = (await readdir(dir)).sort();
    expect(names).toContain("email.log");
    expect(names).not.toContain("staff.log");
    const line = await readFile(join(dir, "email.log"), "utf8");
    expect(JSON.parse(line.trim()).channel).toBe("email");
  });
});

describe("OPENEDBOT_LOG_DIR=off", () => {
  test("turns the log files off, any other value (or none) keeps them", async () => {
    const { logFilesEnabled, logsDirectory } = await import("../src/log/files");
    const previous = process.env.OPENEDBOT_LOG_DIR;
    try {
      process.env.OPENEDBOT_LOG_DIR = " OFF ";
      expect(logFilesEnabled()).toBe(false);
      expect(logsDirectory()).not.toContain("OFF");
      process.env.OPENEDBOT_LOG_DIR = "/tmp/openedbot-logs";
      expect([logFilesEnabled(), logsDirectory()]).toEqual([true, "/tmp/openedbot-logs"]);
      delete process.env.OPENEDBOT_LOG_DIR;
      expect(logFilesEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENEDBOT_LOG_DIR;
      else process.env.OPENEDBOT_LOG_DIR = previous;
    }
  });
});
