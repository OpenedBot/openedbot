/** A private, bounded fixture. Its origin must be explicitly reachable from the lab. */
export type ToolFixtureConfig = { fixtureOrigin?: string | null; fixturePort?: number; fixtureBind?: string };

export type FixtureSource = { url: string; value: string; reads: number };
export type BrowserFixtureSubmission = { botId: string; runId: string; value: string; receipt: string };
export type BrowserFixturePage = {
  url: string; botId: string; runId: string | null; value: string; receipt: string;
  loads: number; bootstraps: number; interactions: number; submissions: BrowserFixtureSubmission[];
  bindRun(runId: string): void;
};
type BrowserState = { page: BrowserFixturePage; cookie: string; ticket: string; witness: string | null };

/** Runs inside the served page: the challenge never appears in the initial HTML. */
function browserPageScript(path: string): void {
  const status = document.querySelector<HTMLElement>('#status')!;
  const form = document.querySelector<HTMLFormElement>('form')!;
  const input = document.querySelector<HTMLInputElement>('#answer')!;
  const button = document.querySelector<HTMLButtonElement>('button')!;
  const post = async (endpoint: string, body: unknown) => fetch(`${path}/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  void (async () => {
    const response = await fetch(`${path}/bootstrap`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Challenge unavailable');
    const challenge = await response.json();
    const value = String.fromCharCode(...challenge.encoded.map((byte: number) => byte ^ 23));
    document.querySelector('#challenge')!.textContent = value;
    document.body.dataset.challenge = value;
    document.body.dataset.botId = challenge.botId;
    document.body.dataset.runId = challenge.runId;
    let witness: string | null = null;
    input.addEventListener('input', (event) => {
      if (!event.isTrusted || input.value !== value) return;
      witness ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      void post('input', { ticket: challenge.ticket, witness, value, botId: challenge.botId, runId: challenge.runId }).then((result) => {
        if (!result.ok) throw new Error('Input evidence rejected');
        button.disabled = false;
        status.textContent = 'Ready to submit';
      }).catch(() => { status.textContent = 'Input evidence failed'; });
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!event.isTrusted || !witness || button.disabled) return;
      button.disabled = true;
      void post('submit', { ticket: challenge.ticket, witness, value: input.value, botId: challenge.botId, runId: challenge.runId })
        .then(async (result) => {
          if (!result.ok) throw new Error('Submission rejected');
          const receipt = await result.json();
          status.textContent = `Submitted: ${receipt.receipt}`;
          document.body.dataset.receipt = receipt.receipt;
        }).catch(() => { status.textContent = 'Submission failed'; });
    });
    status.textContent = 'Read the code and type it into Validation code';
  })().catch(() => { status.textContent = 'Challenge unavailable'; });
}

export class ToolFixture {
  private readonly sources = new Map<string, FixtureSource>();
  private readonly namespace = crypto.randomUUID();
  private readonly browsers = new Map<string, BrowserState>();
  private server: ReturnType<typeof Bun.serve> | null = null;

  private constructor(readonly origin: string, private readonly requestedPort: number) {}

  get port(): number { return this.server?.port ?? this.requestedPort; }

  static start(config: ToolFixtureConfig): ToolFixture {
    if (!config.fixtureOrigin) throw new Error("E2E_FIXTURE_ORIGIN is required: expose the controlled loopback fixture to the intended runtime explicitly.");
    const origin = new URL(config.fixtureOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error("E2E_FIXTURE_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment.");
    }
    const fixture = new ToolFixture(origin.origin, config.fixturePort ?? 18871);
    fixture.server = Bun.serve({
      hostname: config.fixtureBind ?? "127.0.0.1", port: fixture.port,
      maxRequestBodySize: 4096,
      fetch: (request) => fixture.respond(request),
    });
    return fixture;
  }

  source(): FixtureSource {
    const path = `/${this.namespace}/${crypto.randomUUID()}/source.txt`;
    // The value is never put into a model prompt. A successful retrieval must
    // cross the fixture boundary and be independently observed here.
    const source = { url: `${this.origin}${path}`, value: crypto.randomUUID().replaceAll('-', ''), reads: 0 };
    this.sources.set(path, source);
    return source;
  }

  browserPage(botId: string): BrowserFixturePage {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) throw new Error('A browser fixture requires an exact bot identity.');
    const path = `/${this.namespace}/${crypto.randomUUID()}/browser`;
    const page: BrowserFixturePage = {
      url: `${this.origin}${path}`, botId, runId: null, value: crypto.randomUUID().replaceAll('-', ''),
      receipt: `BROWSER_RECEIPT_${crypto.randomUUID().replaceAll('-', '')}`,
      loads: 0, bootstraps: 0, interactions: 0, submissions: [],
      bindRun(runId) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId) || this.runId && this.runId !== runId) throw new Error('Browser fixture cannot be rebound to another run.');
        this.runId = runId;
      },
    };
    this.browsers.set(path, { page, cookie: crypto.randomUUID(), ticket: crypto.randomUUID(), witness: null });
    return page;
  }

  respond(request: Request): Response | Promise<Response> {
    const path = new URL(request.url).pathname;
    const browserPath = path.replace(/\/(?:bootstrap|input|submit)$/, '');
    const browser = this.browsers.get(browserPath);
    if (browser) return this.browserResponse(request, browserPath, browser);
    const source = this.sources.get(path);
    if (!source) return new Response("Not found", { status: 404 });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    source.reads += 1;
    return new Response(`${source.value}\n`, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  }

  private async browserResponse(request: Request, path: string, state: BrowserState): Promise<Response> {
    const { page, cookie, ticket } = state;
    const url = new URL(request.url);
    const endpoint = url.pathname.slice(path.length);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const error = (message: string, status: number) => new Response(message, { status, headers });
    if (!page.runId) return error('Browser fixture is not bound to an admitted run', 503);
    if (!endpoint && request.method === 'GET') {
      page.loads++;
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>openedbot browser acceptance</title></head><body><h1>Browser form acceptance</h1><p>Read this code: <strong id="challenge">Loading</strong></p><form><label for="answer">Validation code</label><input id="answer" autocomplete="off"><button type="submit" disabled>Submit validation</button></form><p id="status" role="status">Loading challenge</p><script>(${browserPageScript.toString()})(${JSON.stringify(path)})</script></body></html>`, {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `openedbot_browser_fixture=${cookie}; Path=${path}; HttpOnly; SameSite=Strict`,
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
      });
    }
    if (!request.headers.get('cookie')?.split(';').some((part) => part.trim() === `openedbot_browser_fixture=${cookie}`)) return error('Page session required', 403);
    if (endpoint === '/bootstrap' && request.method === 'GET') {
      page.bootstraps++;
      return Response.json({ encoded: Array.from(page.value, (char) => char.charCodeAt(0) ^ 23), ticket, botId: page.botId, runId: page.runId }, { headers });
    }
    if (!['/input', '/submit'].includes(endpoint) || request.method !== 'POST') return error('Method or route not allowed', 405);
    if (request.headers.get('origin') !== url.origin || request.headers.get('content-type')?.split(';')[0] !== 'application/json') return error('Same-origin JSON interaction required', 403);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 4096) return error('Body too large', 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return error('Invalid JSON', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error('Invalid interaction', 400);
    const fields = body as Record<string, unknown>;
    if (fields.ticket !== ticket || fields.botId !== page.botId || fields.runId !== page.runId || fields.value !== page.value
      || typeof fields.witness !== 'string' || !/^[a-f0-9]{32}$/.test(fields.witness)) return error('Bound challenge mismatch', 403);
    if (endpoint === '/input') {
      if (page.bootstraps === 0 || page.submissions.length) return error('No active page challenge', 409);
      state.witness = fields.witness;
      page.interactions++;
      return Response.json({ accepted: true }, { headers });
    }
    if (page.submissions.length) return error('Already submitted', 409);
    if (!state.witness || state.witness !== fields.witness || page.interactions === 0) return error('DOM input evidence required', 403);
    const submission = { botId: page.botId, runId: page.runId, value: page.value, receipt: page.receipt };
    page.submissions.push(submission);
    return Response.json({ receipt: page.receipt }, { headers });
  }

  async stop(): Promise<void> { await this.server?.stop(true); this.server = null; }
}

/** Generate an ASCII-only PDF without requiring extra packages on the runtime. */
export function pdfWriterScript(sourcePath: string, pdfPath: string): string {
  return [
    "from pathlib import Path",
    `text = Path(${JSON.stringify(sourcePath)}).read_text().strip()`,
    "assert text and all(c in '0123456789ABCDEF' for c in text), 'Source was not converted to uppercase hex'",
    "stream = ('BT /F1 12 Tf 20 50 Td (' + text + ') Tj ET').encode('ascii')",
    "objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length ' + str(len(stream)).encode() + b' >>\\nstream\\n' + stream + b'\\nendstream']",
    "pdf = bytearray(b'%PDF-1.4\\n'); offsets = [0]",
    "for i, obj in enumerate(objects, 1):\n offsets.append(len(pdf)); pdf.extend(str(i).encode() + b' 0 obj\\n' + obj + b'\\nendobj\\n')",
    "start = len(pdf); pdf.extend(b'xref\\n0 6\\n0000000000 65535 f \\n')",
    "for offset in offsets[1:]: pdf.extend(('%010d 00000 n \\n' % offset).encode())",
    "pdf.extend(('trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n%d\\n%%%%EOF\\n' % start).encode())",
    `Path(${JSON.stringify(pdfPath)}).write_bytes(pdf)`,
    "print('E2E_PDF_WRITTEN')",
  ].join("\n");
}
