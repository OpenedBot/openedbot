// Drives the dev window over the Chrome DevTools Protocol (port opened by
// main.ts in `electron-vite dev` only). No dependency: Bun's WebSocket.
//
//   bun scripts/cdp.ts eval "document.title"
//   bun scripts/cdp.ts click "[data-board-sidebar-head] button[aria-controls]"
//   bun scripts/cdp.ts shot out.png
//
// Clicks go through CDP input events, i.e. straight to the page: they do NOT
// cross the OS hit test, so a click swallowed by a native drag region
// (`app-region: drag`) still lands here. Use a real mouse for that class of bug.

const port = process.env.OHB_REMOTE_DEBUGGING_PORT ?? "9333";
const [command, arg] = process.argv.slice(2);

type Target = { type: string; url: string; webSocketDebuggerUrl: string };
const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
if (!page) throw new Error(`no page on port ${port}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 0;
const pending = new Map<number, (message: { result?: any; error?: { message: string } }) => void>();
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  pending.get(message.id)?.(message);
};
function send(method: string, params: object = {}): Promise<any> {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result))),
  );
}
async function evaluate(expression: string): Promise<unknown> {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

if (command === "eval" && arg) {
  console.log(JSON.stringify(await evaluate(arg), null, 2));
} else if (command === "click" && arg) {
  const box = (await evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(arg)})?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  )) as { x: number; y: number } | undefined;
  if (!box) throw new Error(`no element for ${arg}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  console.log(`clicked ${arg} at ${Math.round(box.x)},${Math.round(box.y)}`);
} else if (command === "shot" && arg) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(arg, Buffer.from(data, "base64"));
  console.log(`wrote ${arg}`);
} else {
  console.error("usage: bun scripts/cdp.ts eval <js> | click <selector> | shot <file.png>");
  process.exitCode = 2;
}
socket.close();
