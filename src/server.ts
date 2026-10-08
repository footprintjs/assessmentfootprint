import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AssessmentRun, CriterionDefinition, ProjectInfo, ReviewInput, RunInput, RunSummary, ToolDefinition } from './types.ts';

export interface ServerEngine {
  getCatalog(): CriterionDefinition[];
  getTools(): Promise<ToolDefinition[]>;
  inspectProject(projectPath: string): Promise<ProjectInfo>;
  runAssessment(input: RunInput): Promise<AssessmentRun>;
  listRuns(): RunSummary[];
  getRun(id: string): AssessmentRun | null;
  submitReview(input: ReviewInput): AssessmentRun;
  readEvidence(runId: string, evidenceId: string): Buffer;
  exportReport(runId: string, format: 'json' | 'html'): string;
}

const bodyLimit = 64 * 1024;
const staticFiles = new Map([
  ['/', { name: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { name: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { name: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { name: 'styles.css', type: 'text/css; charset=utf-8' }],
]);
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function textField(body: Record<string, unknown>, name: string, maxLength = 4096): string {
  const value = body[name];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes('\0')) {
    throw new HttpError(400, `${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'];
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'Use application/json for request bodies.');
  }
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
    throw new HttpError(413, 'Request body exceeds 64 KB.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > bodyLimit) throw new HttpError(413, 'Request body exceeds 64 KB.');
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requireRun(engine: ServerEngine, runId: string): AssessmentRun {
  const run = engine.getRun(runId);
  if (!run) throw new HttpError(404, 'Assessment run was not found.');
  return run;
}

/** The session token and origin checks prevent unrelated websites from controlling local assessments. */
export async function startServer(options: { engine: ServerEngine; projectPath: string; dataDir: string; port?: number }) {
  const { engine, projectPath, dataDir } = options;
  const sessionToken = randomBytes(32).toString('hex');
  let origin = '';
  let host = '';

  const server = createServer((req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    void (async () => {
      if (req.headers.host !== host) throw new HttpError(403, 'This server only accepts its local address.');
      if (req.headers.origin !== undefined && req.headers.origin !== origin) {
        throw new HttpError(403, 'Requests from another origin are not allowed.');
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        throw new HttpError(403, 'Requests from another website are not allowed.');
      }
      if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'Method is not allowed.');
      if (req.method === 'POST') {
        const supplied = req.headers['x-assessment-session'];
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(sessionToken) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(sessionToken))) {
          throw new HttpError(403, 'A valid assessment session is required.');
        }
      }

      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin) throw new HttpError(403, 'This server only accepts its local address.');
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        return json(res, 200, { projectPath, dataDir, catalog: engine.getCatalog(), tools: await engine.getTools(), runs: engine.listRuns(), sessionToken });
      }
      if (req.method === 'GET' && url.pathname === '/api/tools') return json(res, 200, await engine.getTools());
      if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, engine.listRuns());
      if (req.method === 'POST' && url.pathname === '/api/projects/inspect') {
        const body = await readJson(req);
        return json(res, 200, await engine.inspectProject(textField(body, 'projectPath')));
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const body = await readJson(req);
        const input: RunInput = { projectPath: textField(body, 'projectPath') };
        if (body.criterionIds !== undefined) {
          if (!Array.isArray(body.criterionIds) || body.criterionIds.length > 256 || body.criterionIds.some(value => typeof value !== 'string' || !value || value.length > 256)) {
            throw new HttpError(400, 'criterionIds must be an array of criterion identifiers.');
          }
          input.criterionIds = body.criterionIds as string[];
        }
        if (body.networkMode !== undefined && body.networkMode !== 'offline' && body.networkMode !== 'online') {
          throw new HttpError(400, 'networkMode must be offline or online.');
        }
        input.networkMode = body.networkMode === 'online' ? 'online' : 'offline';
        return json(res, 201, await engine.runAssessment(input));
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && runMatch) return json(res, 200, requireRun(engine, decodeURIComponent(runMatch[1])));
      const reviewMatch = /^\/api\/runs\/([^/]+)\/reviews$/.exec(url.pathname);
      if (req.method === 'POST' && reviewMatch) {
        const runId = decodeURIComponent(reviewMatch[1]);
        requireRun(engine, runId);
        const body = await readJson(req);
        const decision = body.decision;
        if (decision !== 'satisfied' && decision !== 'not_satisfied' && decision !== 'insufficient_evidence') {
          throw new HttpError(400, 'decision must be satisfied, not_satisfied, or insufficient_evidence.');
        }
        return json(res, 200, engine.submitReview({ runId, criterionId: textField(body, 'criterionId', 256), reviewer: textField(body, 'reviewer', 256), decision, rationale: textField(body, 'rationale', 16000) }));
      }
      const evidenceMatch = /^\/api\/runs\/([^/]+)\/evidence\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && evidenceMatch) {
        const runId = decodeURIComponent(evidenceMatch[1]);
        const evidenceId = decodeURIComponent(evidenceMatch[2]);
        const run = requireRun(engine, runId);
        if (!run.evidence.some(record => record.id === evidenceId)) throw new HttpError(404, 'Evidence was not found.');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(engine.readEvidence(runId, evidenceId));
      }
      const exportMatch = /^\/api\/runs\/([^/]+)\/export$/.exec(url.pathname);
      if (req.method === 'GET' && exportMatch) {
        const runId = decodeURIComponent(exportMatch[1]);
        requireRun(engine, runId);
        const format = url.searchParams.get('format') ?? 'json';
        if (format !== 'html' && format !== 'json') throw new HttpError(400, 'Report format must be html or json.');
        const filename = `assessment-${runId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format}`;
        res.setHeader('Content-Type', format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
        return res.end(engine.exportReport(runId, format));
      }

      const asset = req.method === 'GET' ? staticFiles.get(url.pathname) : undefined;
      if (asset) {
        try {
          const contents = await readFile(fileURLToPath(new URL(`../web/${asset.name}`, import.meta.url)));
          res.setHeader('Content-Type', asset.type);
          return res.end(contents);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Application file was not found.');
          throw error;
        }
      }
      throw new HttpError(404, 'Requested resource was not found.');
    })().catch((error: unknown) => {
      if (res.headersSent || res.destroyed) return;
      // Engine domain errors carry an HTTP status; unexpected errors remain server failures.
      const domainStatus = error instanceof Error && 'status' in error ? (error as Error & { status: unknown }).status : undefined;
      const status = typeof domainStatus === 'number' && Number.isInteger(domainStatus) && domainStatus >= 400 && domainStatus < 500 ? domainStatus : error instanceof URIError ? 400 : 500;
      const message = error instanceof Error ? error.message : 'The request could not be completed.';
      json(res, status, { error: message });
      // Drain a rejected body so the connection can finish without buffering it.
      if (!req.destroyed) req.resume();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Unable to determine local server address.'));
      host = `127.0.0.1:${address.port}`;
      origin = `http://${host}`;
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    url: origin,
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
