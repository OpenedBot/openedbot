import { appendRunEventsTx } from "../../modules/execution/src/application/run-events";
/** Disposable database + real API + Mailpit worker for the MCP desktop recipe. No production host or provider. */
import { withMvpFixture } from "../integration/mvp-workflows";
import {
  createTransactionalEmailSender,
  processEmailOutbox,
} from "@openedbot/notifications/application/email";
import { mkdir, rm } from "node:fs/promises";

await withMvpFixture(
  async ({ database, organizationId, userId, botId, threadId }) => {
    const artifacts = "tmp/e2e-desktop-mvp";
    await mkdir(artifacts, { recursive: true });
    const apiUrl = new URL(
      process.env.API_DATABASE_URL ||
        "postgres://openedbot_api:openedbot_api_dev@127.0.0.1:5432/openedbot",
    );
    const target = new URL(database.url);
    apiUrl.host = target.host;
    apiUrl.pathname = target.pathname;
    const log = Bun.file(`${artifacts}/api.log`);
    const api = Bun.spawn(["bun", "apps/api/src/index.ts"], {
      env: {
        ...process.env,
        API_PORT: "8795",
        API_DB_MAX: "4",
        API_INTERNAL_URL: "http://127.0.0.1:8795",
        API_PUBLIC_URL: "http://localhost:8795",
        WEB_APP_URL: "http://localhost:1432",
        API_DATABASE_URL: apiUrl.toString(),
        BLOB_DRIVER: "file",
        BLOB_FILE_ROOT: `${process.cwd()}/${artifacts}/blobs`,
        OPENEDBOT_PLUGINS: "",
        OPENEDBOT_ENV: "development",
        DEV_SIGN_IN: "0",
      },
      stdout: log,
      stderr: log,
    });
    const worker = await database.connect("openedbot_worker");
    const config = {
      endpoint: null,
      smtpUrl: "smtp://127.0.0.1:1025",
      brevoApiKey: null,
      resendApiKey: null,
      resendBaseUrl: "https://api.resend.com",
      token: null,
      from: "openedbot@openedbot.local",
      timeoutMs: 5000,
      leaseSeconds: 60,
      maxAttempts: 3,
      workerId: "mvp-desktop-lab",
      webAppUrl: "http://localhost:1432",
    };
    const sender = createTransactionalEmailSender(config);
    if (!sender) throw new Error("Mailpit sender missing");
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void processEmailOutbox(worker, sender, config)
        .catch((error) => console.error(error.name))
        .finally(() => {
          running = false;
        });
    }, 500);
    const email = `mvp-${userId}@example.test`;
    await Bun.write(
      `${artifacts}/fixture.json`,
      JSON.stringify({ organizationId, userId, botId, threadId, email }),
    );
    let stop!: () => void;
    const done = new Promise<void>((resolve) => {
      stop = resolve;
    });
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 8796,
      async fetch(request) {
        if (request.method !== "POST")
          return new Response("POST required", { status: 405 });
        const url = new URL(request.url);
        if (url.pathname === "/complete") {
          const workflowId = crypto.randomUUID(),
            runId = crypto.randomUUID(),
            messageId = crypto.randomUUID(),
            attachmentId = crypto.randomUUID();
          await Bun.write(
            `${artifacts}/blobs/org/${organizationId}/${attachmentId}`,
            "Rapport de recette MVP.\n",
          );
          await database.owner.begin(async (tx) => {
            await tx`insert into workflows(id,organization_id,thread_id,root_run_id,root_bot_id,initiator_user_id,kind) values(${workflowId},${organizationId},${threadId},${runId},${botId},${userId},'dm')`;
            await tx`insert into runs(id,organization_id,thread_id,bot_id,input,status,output,workflow_id,step_index,step_kind,external_state,initiator_user_id,ended_at)
          values(${runId},${organizationId},${threadId},${botId},'Test MVP','completed','Rapport de recette disponible.',${workflowId},0,'root','settled',${userId},now())`;
            await tx`insert into messages(id,organization_id,thread_id,run_id,role,content)
            values(${crypto.randomUUID()},${organizationId},${threadId},${runId},'user',${[{ type: "text", text: "Prépare un rapport de recette MVP." }]})`;
            await tx`insert into messages(id,organization_id,thread_id,run_id,role,content) values(${messageId},${organizationId},${threadId},${runId},'assistant',${[
              { type: "text", text: "Rapport de recette disponible." },
              {
                type: "attachment",
                id: attachmentId,
                name: "rapport-mvp.txt",
                contentType: "text/plain",
                kind: "document",
                bytes: 25,
              },
            ]})`;
            await tx`insert into attachments(id,organization_id,message_id,object_key,driver,name,content_type,kind,bytes) values(${attachmentId},${organizationId},${messageId},${`org/${organizationId}/${attachmentId}`},'file','rapport-mvp.txt','text/plain','document',${new TextEncoder().encode("Rapport de recette MVP.\n").length})`;
            await appendRunEventsTx(tx, [
              {
                organizationId,
                threadId,
                runId,
                type: "agent.message",
                payload: { text: "Rapport de recette disponible." },
              },
              {
                organizationId,
                threadId,
                runId,
                type: "run.completed",
                payload: { output: "Rapport de recette disponible." },
              },
            ]);
            await tx`update workflows set status='running',updated_at=clock_timestamp() where id=${workflowId}`;
            await tx`update workflows set status='completed',updated_at=clock_timestamp() where id=${workflowId}`;
          });
          return Response.json({ workflowId });
        }
        if (url.pathname === "/stop") {
          // Flush the acknowledgement before closing the control listener.
          setTimeout(stop, 25);
          return new Response("stopping");
        }
        return new Response("Unknown fixture", { status: 404 });
      },
    });
    try {
      console.info(
        "MVP desktop lab preparing on API :8795; fixture metadata in tmp/e2e-desktop-mvp/fixture.json",
      );
      await done;
    } finally {
      control.stop(true);
      clearInterval(timer);
      api.kill("SIGTERM");
      await api.exited;
      while (running) await Bun.sleep(50);
      await rm(`${artifacts}/blobs/org/${organizationId}`, {
        recursive: true,
        force: true,
      });
      console.info("MVP lab stopped; disposable database cleanup follows.");
    }
  },
);
