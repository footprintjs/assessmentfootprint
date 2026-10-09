import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Parser } from 'tar';
import type { ReadEntry } from 'tar';
import { AssessmentError } from './errors.ts';
import type { ProjectSource, SourceImportInput } from './types.ts';

export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface SourceLimits { downloadBytes: number; expandedBytes: number; fileBytes: number; entries: number; requestMs: number; extractionMs: number; receiptBytes: number }
export const SOURCE_LIMITS: Readonly<SourceLimits> = Object.freeze({ downloadBytes: 32 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, entries: 5000, requestMs: 60_000, extractionMs: 30_000, receiptBytes: 4 * 1024 * 1024 });
type ImportedFile = { path: string; bytes: number; sha256: string };
type Receipt = { schemaVersion: 1; source: ProjectSource; files: ImportedFile[] };
type ParsedSource = { kind: 'github'; requested: string; name: string } | { kind: 'npm'; requested: string; name: string; version: string };
const githubName = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const npmVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function bad(message: string, status = 400): never { throw new AssessmentError(status, message); }

function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return bad('Use a recognized public GitHub or npm source.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) bad('Source URLs must use HTTPS without credentials, ports, queries or fragments.');
  return url;
}

export function parseSource(input: SourceImportInput): ParsedSource {
  if (!input || !['github', 'npm'].includes(input.kind) || typeof input.source !== 'string' || !input.source.trim() || input.source.length > 2048 || /[\u0000-\u001f\u007f]/.test(input.source)) bad('Choose a public GitHub repository or npm package source.');
  const requested = input.source.trim();
  if (input.kind === 'github') {
    const url = publicUrl(requested);
    if (url.hostname !== 'github.com') bad('Use a github.com repository URL.');
    const name = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '');
    if (!githubName.test(name) || name.split('/')[1] === '.' || name.split('/')[1] === '..') bad('Use the repository URL https://github.com/OWNER/REPOSITORY, without a tree or issue path.');
    return { kind: 'github', requested, name };
  }
  let spec = requested;
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(spec)) {
    const url = publicUrl(spec);
    if (url.hostname !== 'www.npmjs.com' && url.hostname !== 'npmjs.com') bad('Use an npmjs.com package URL or an npm package name.');
    const match = /^\/package\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:\/v\/([^/]+))?\/?$/.exec(url.pathname);
    if (!match) bad('Use an npm package URL, optionally followed by /v/EXACT_VERSION.');
    spec = match[1] + (match[2] ? `@${match[2]}` : '');
  }
  const split = spec.lastIndexOf('@');
  const hasVersion = split > 0;
  const name = hasVersion ? spec.slice(0, split) : spec;
  const version = hasVersion ? spec.slice(split + 1) : 'latest';
  if (!npmName.test(name) || name.length > 214 || (version !== 'latest' && !npmVersion.test(version))) bad('Use an npm package name with an optional exact version; ranges and alternate registries are unsupported.');
  return { kind: 'npm', requested, name, version };
}

function allowedEndpoint(value: string, kind: 'github' | 'npm', archive: boolean): URL {
  const url = publicUrl(value);
  if (kind === 'github') {
    if (archive ? url.hostname !== 'codeload.github.com' || !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/tar\.gz\/[a-f\d]{40}$/i.test(url.pathname) : url.hostname !== 'api.github.com' || !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\/commits\/[^/]+)?$/.test(url.pathname)) bad('The GitHub request or redirect is outside supported official endpoints.');
  } else if (url.hostname !== 'registry.npmjs.org' || (archive && !/^\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/-\/[^/]+\.tgz$/.test(url.pathname))) bad('The npm request or redirect is outside the official registry.');
  return url;
}

async function download(fetcher: SourceFetch, initial: string, kind: 'github' | 'npm', archive: boolean, maximum: number, requestMs: number): Promise<Buffer> {
  let url = initial;
  const pinnedPath = new URL(initial).pathname;
  const signal = AbortSignal.timeout(requestMs);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const endpoint = allowedEndpoint(url, kind, archive);
      if (archive && endpoint.pathname !== pinnedPath) bad('An archive redirect changed its pinned source path.');
      const response = await fetcher(url, { redirect: 'manual', signal, credentials: 'omit', headers: { Accept: archive ? 'application/octet-stream' : 'application/json', 'User-Agent': 'AssessmentFootprint-local-import', ...(kind === 'github' && !archive ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) bad('Source download exceeded its supported redirect limit.');
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); bad(response.status === 403 || response.status === 429 ? 'The public source service refused the request or reached its unauthenticated rate limit. Try again later.' : 'The public source or exact revision could not be downloaded. Private sources are unsupported.', response.status === 429 ? 429 : 400); }
      if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); bad('Source download exceeds the supported size limit.', 413); }
      if (!response.body) bad('Source service returned no downloadable content.');
      const reader = response.body.getReader();
      const abortRead = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abortRead, { once: true });
      const chunks: Buffer[] = [];
      let count = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const result = await reader.read();
          signal.throwIfAborted();
          if (result.done) break;
          count += result.value.byteLength;
          if (count > maximum) bad('Source download exceeds the supported size limit.', 413);
          chunks.push(Buffer.from(result.value));
        }
      } finally { signal.removeEventListener('abort', abortRead); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return Buffer.concat(chunks);
    }
  } catch (error) {
    if (error instanceof AssessmentError) throw error;
    bad(signal.aborted ? 'Source download timed out.' : 'The public source request could not complete. Check network access and try again.', signal.aborted ? 408 : 400);
  }
  return bad('Source download could not complete.');
}

async function metadata(fetcher: SourceFetch, url: string, kind: 'github' | 'npm', limits: SourceLimits): Promise<Record<string, unknown>> {
  const bytes = await download(fetcher, url, kind, false, 1024 * 1024, limits.requestMs);
  try { const value: unknown = JSON.parse(bytes.toString('utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* Invalid remote data is never treated as a source pin. */ }
  return bad('Source service returned invalid metadata.');
}

function verifyIntegrity(bytes: Buffer, integrity: unknown): string {
  if (typeof integrity !== 'string' || integrity.length > 2048) bad('The npm release has no supported integrity digest.');
  const tokens = integrity.split(/\s+/).map(token => /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(token)).filter(match => match !== null);
  const preferred = ['sha512', 'sha384', 'sha256'].find(algorithm => tokens.some(token => token[1] === algorithm));
  if (!preferred) bad('The npm release has no supported integrity digest.');
  const actual = createHash(preferred).update(bytes).digest();
  if (!tokens.some(token => { if (token[1] !== preferred) return false; const expected = Buffer.from(token[2], 'base64'); return expected.length === actual.length && timingSafeEqual(expected, actual); })) bad('The npm archive failed its advertised integrity check.', 422);
  return integrity;
}

function archivePath(value: string, directory: boolean): string[] {
  const path = directory ? value.replace(/\/$/, '') : value;
  const parts = path.split('/');
  if (!path || Buffer.byteLength(path) > 2048 || parts.length > 33 || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255 || /[\\:\u0000-\u001f\u007f<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) bad('The archive contains an unsafe or unsupported portable path.');
  return parts;
}

async function extractArchive(bytes: Buffer, projectPath: string, kind: 'github' | 'npm', limits: SourceLimits): Promise<ImportedFile[]> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) bad('The source archive is not a gzip tar archive.');
  const files: ImportedFile[] = [];
  const explicitPaths = new Set<string>();
  const aliases = new Map<string, string>();
  const folders = new Set<string>();
  let container: string | undefined;
  let expandedBytes = 0;
  let declaredBytes = 0;
  let entries = 0;
  let metadataEntries = 0;
  let fileDescriptor: number | undefined;
  const parser = new Parser({ strict: true, maxMetaEntrySize: 64 * 1024, brotli: false, zstd: false });
  const fail = (error: unknown) => parser.abort(error instanceof Error ? error : new Error('Archive extraction failed.'));
  parser.on('ignoredEntry', () => fail(new AssessmentError(400, 'The archive contains unsupported or excessive metadata entries.')));
  parser.on('meta', () => { if (++metadataEntries > limits.entries) fail(new AssessmentError(413, 'The archive contains too many metadata entries.')); });
  parser.on('entry', (entry: ReadEntry) => {
    try {
      if (++entries > limits.entries) bad('The archive contains too many entries.', 413);
      if (entry.type !== 'Directory' && entry.type !== 'File' && entry.type !== 'OldFile') bad('The archive contains a link or unsupported special entry.');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.fileBytes || (entry.type === 'Directory' && entry.size !== 0)) bad('An archive entry exceeds the supported file size.', 413);
      const parts = archivePath(entry.path, entry.type === 'Directory');
      container ??= parts[0];
      if (parts[0] !== container || (kind === 'npm' && container !== 'package')) bad('The source archive must have one supported root directory.');
      const local = parts.slice(1).join('/');
      if (!local) { if (entry.type !== 'Directory') bad('The source archive root must be a directory.'); entry.resume(); return; }
      if (parts[1].toLowerCase() === '.git') bad('Imported archives must not contain repository Git control files.');
      const alias = local.normalize('NFC').toLowerCase();
      if (explicitPaths.has(alias)) bad('The archive contains duplicate or colliding paths.');
      explicitPaths.add(alias);
      for (let index = 1; index < parts.length; index++) {
        const prefix = parts.slice(1, index + 1).join('/');
        const normalized = prefix.normalize('NFC').toLowerCase();
        const prior = aliases.get(normalized);
        if (prior !== undefined && prior !== prefix) bad('The archive contains case or Unicode path collisions.');
        aliases.set(normalized, prefix);
      }
      const target = resolve(projectPath, local);
      if (!target.startsWith(projectPath + sep)) bad('The archive path escapes its project directory.');
      if (entry.type === 'Directory') { mkdirSync(target, { recursive: true, mode: 0o700 }); folders.add(local); entry.resume(); return; }
      if (folders.has(local)) bad('The archive contains a file/directory collision.');
      declaredBytes += entry.size;
      if (declaredBytes > limits.expandedBytes) bad('The archive exceeds the supported extracted size.', 413);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const fd = openSync(target, 'wx', 0o600);
      fileDescriptor = fd;
      const digest = createHash('sha256');
      let written = 0;
      entry.on('data', (chunk: Buffer) => {
        try {
          written += chunk.length;
          if (written > entry.size || written > limits.fileBytes) bad('An archive file exceeds its declared or supported size.', 413);
          let offset = 0;
          while (offset < chunk.length) { const count = writeSync(fd, chunk, offset, chunk.length - offset); if (count <= 0) throw new Error('Archive file write made no progress.'); offset += count; }
          digest.update(chunk);
        } catch (error) { fail(error); }
      });
      entry.on('end', () => {
        try {
          closeSync(fd); fileDescriptor = undefined;
          if (written !== entry.size) bad('An archive file was truncated.');
          files.push({ path: local, bytes: written, sha256: digest.digest('hex') });
        } catch (error) { fail(error); }
      });
      entry.on('error', fail);
      entry.resume();
    } catch (error) { fail(error); entry.resume(); }
  });
  let prefix = Buffer.alloc(0);
  let checkedPrefix = false;
  const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    expandedBytes += chunk.length;
    if (expandedBytes > limits.expandedBytes) return callback(new AssessmentError(413, 'The decompressed archive exceeds the supported size.'));
    if (!checkedPrefix) {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length < 4) return callback();
      if ((prefix[0] === 0x1f && prefix[1] === 0x8b) || prefix.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return callback(new AssessmentError(400, 'Nested compressed archives are unsupported.'));
      checkedPrefix = true;
      const first = prefix;
      prefix = Buffer.alloc(0);
      return callback(null, first);
    }
    callback(null, chunk);
  } });
  try { await pipeline(Readable.from([bytes]), createGunzip(), bound, parser, { signal: AbortSignal.timeout(limits.extractionMs) }); }
  catch (error) { if (error instanceof AssessmentError) throw error; bad('The source archive could not be safely extracted.'); }
  finally { if (fileDescriptor !== undefined) { try { closeSync(fileDescriptor); } catch { /* Already closed by an aborted entry. */ } } }
  if (!files.length) bad('The source archive contains no regular project files.');
  return files;
}

export class SourceImporter {
  private readonly fetcher: SourceFetch;
  private readonly limits: SourceLimits;
  private readonly validateProject?: (path: string) => Promise<void>;
  constructor(privateDataDir: string, options: { fetch?: SourceFetch; limits?: Partial<SourceLimits>; validateProject?: (path: string) => Promise<void> } = {}) {
    this.dataDir = resolve(privateDataDir);
    this.fetcher = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.limits = { ...SOURCE_LIMITS, ...options.limits };
    this.validateProject = options.validateProject;
  }
  private readonly dataDir: string;

  async import(input: SourceImportInput): Promise<{ projectPath: string; source: ProjectSource }> {
    const parsed = parseSource(input);
    let name = parsed.name;
    let revision: string;
    let reference: string;
    let archiveUrl: string;
    let integrity: string | null = null;
    if (parsed.kind === 'github') {
      const repo = await metadata(this.fetcher, `https://api.github.com/repos/${name}`, 'github', this.limits);
      if (repo.private !== false || typeof repo.full_name !== 'string' || repo.full_name.toLowerCase() !== name.toLowerCase() || !githubName.test(repo.full_name) || typeof repo.default_branch !== 'string' || !repo.default_branch || repo.default_branch.length > 255) bad('The public repository metadata could not establish a default branch.');
      name = repo.full_name;
      reference = repo.default_branch;
      const commit = await metadata(this.fetcher, `https://api.github.com/repos/${name}/commits/${encodeURIComponent(reference)}`, 'github', this.limits);
      if (typeof commit.sha !== 'string' || !/^[a-f\d]{40}$/i.test(commit.sha)) bad('The repository default branch could not be pinned to an exact commit.');
      revision = commit.sha.toLowerCase();
      archiveUrl = `https://codeload.github.com/${name}/tar.gz/${revision}`;
    } else {
      const release = await metadata(this.fetcher, `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(parsed.version)}`, 'npm', this.limits);
      if (release.name !== name || typeof release.version !== 'string' || !npmVersion.test(release.version) || (parsed.version !== 'latest' && release.version !== parsed.version) || !release.dist || typeof release.dist !== 'object' || Array.isArray(release.dist)) bad('The npm metadata could not establish the requested exact release.');
      const dist = release.dist as Record<string, unknown>;
      if (typeof dist.tarball !== 'string') bad('The npm release does not name a supported archive.');
      allowedEndpoint(dist.tarball, 'npm', true);
      revision = release.version;
      reference = parsed.version;
      archiveUrl = dist.tarball;
      if (!new URL(archiveUrl).pathname.startsWith(`/${name}/-/`)) bad('The npm archive path does not match its resolved package.');
      integrity = typeof dist.integrity === 'string' ? dist.integrity : null;
    }
    const archive = await download(this.fetcher, archiveUrl, parsed.kind, true, this.limits.downloadBytes, this.limits.requestMs);
    if (parsed.kind === 'npm') integrity = verifyIntegrity(archive, integrity);
    const importsRoot = join(this.dataDir, 'imports');
    if (existsSync(importsRoot) && lstatSync(importsRoot).isSymbolicLink()) bad('The managed import directory must not be a symbolic link.', 409);
    mkdirSync(importsRoot, { recursive: true, mode: 0o700 });
    if (!realpathSync(importsRoot).startsWith(realpathSync(this.dataDir) + sep)) bad('The managed import directory escaped its data directory.', 409);
    const staging = mkdtempSync(join(importsRoot, '.import-'));
    const id = randomUUID();
    const destination = join(importsRoot, id);
    try {
      const projectPath = join(staging, 'project');
      mkdirSync(projectPath, { mode: 0o700 });
      const files = await extractArchive(archive, projectPath, parsed.kind, this.limits);
      if (parsed.kind === 'npm') {
        const packagePath = join(projectPath, 'package.json');
        if (!existsSync(packagePath) || statSync(packagePath).size > 1024 * 1024) bad('The npm archive is missing a bounded root package manifest.');
        let manifest: unknown;
        try { manifest = JSON.parse(readFileSync(packagePath, 'utf8')); } catch { bad('The npm archive root package manifest is invalid JSON.'); }
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || (manifest as Record<string, unknown>).name !== name || (manifest as Record<string, unknown>).version !== revision) bad('The npm archive package name or version does not match its pinned release.');
      }
      await this.validateProject?.(projectPath);
      const source: ProjectSource = { kind: parsed.kind, requested: parsed.requested, url: parsed.kind === 'github' ? `https://github.com/${name}` : `https://www.npmjs.com/package/${name}`, name, revision, reference, fetchedAt: new Date().toISOString(), archiveSha256: sha(archive), integrity, fileCount: files.length, extractedBytes: files.reduce((total, file) => total + file.bytes, 0), selectedInputs: 'unchanged', changedPaths: [] };
      const receipt = JSON.stringify({ schemaVersion: 1, source, files } satisfies Receipt);
      if (Buffer.byteLength(receipt) > this.limits.receiptBytes || Buffer.byteLength(receipt) > SOURCE_LIMITS.receiptBytes) bad('The source manifest exceeds its supported receipt size.', 413);
      writeFileSync(join(staging, 'source.json'), receipt, { flag: 'wx', mode: 0o600 });
      renameSync(staging, destination);
      return { projectPath: join(destination, 'project'), source };
    } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  }

  originFor(projectPath: string, requestedPaths: string[], captured: Array<{ path: string; sha256: string; bytes: Buffer }>): ProjectSource | undefined {
    const importsRoot = join(this.dataDir, 'imports');
    if (!existsSync(importsRoot)) return undefined;
    const local = relative(realpathSync(importsRoot), projectPath).split(sep);
    if (local.length !== 2 || !/^[a-f\d-]{36}$/i.test(local[0]) || local[1] !== 'project') return undefined;
    const receiptPath = join(importsRoot, local[0], 'source.json');
    if (!existsSync(receiptPath)) bad('The imported project is missing its source receipt.', 409);
    if (lstatSync(receiptPath).isSymbolicLink() || statSync(receiptPath).size > 4 * 1024 * 1024) bad('The imported source receipt is invalid.', 409);
    let receipt: Receipt;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
      if (receipt.schemaVersion !== 1 || !receipt.source || !['github', 'npm'].includes(receipt.source.kind) || !/^[a-f\d]{64}$/.test(receipt.source.archiveSha256) || !Array.isArray(receipt.files) || receipt.files.length > SOURCE_LIMITS.entries || receipt.files.some(file => typeof file.path !== 'string' || !/^[a-f\d]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) throw new Error('Invalid receipt.');
      const origin = parseSource({ kind: receipt.source.kind, source: receipt.source.url });
      if (origin.name !== receipt.source.name || typeof receipt.source.requested !== 'string' || typeof receipt.source.reference !== 'string' || typeof receipt.source.fetchedAt !== 'string' || !Number.isFinite(Date.parse(receipt.source.fetchedAt)) || receipt.source.fileCount !== receipt.files.length || receipt.source.extractedBytes !== receipt.files.reduce((sum, file) => sum + file.bytes, 0)) throw new Error('Invalid source identity.');
      if (receipt.source.kind === 'github' ? !/^[a-f\d]{40}$/.test(receipt.source.revision) : !npmVersion.test(receipt.source.revision)) throw new Error('Invalid source pin.');
    } catch { return bad('The imported source receipt failed validation.', 409); }
    const baseline = new Map(receipt.files.map(file => [file.path, file]));
    const now = new Map(captured.map(file => [file.path, file]));
    const changedPaths = requestedPaths.filter(path => { const original = baseline.get(path); const current = now.get(path); return Boolean(original || current) && (!original || !current || original.sha256 !== current.sha256 || original.bytes !== current.bytes.length); });
    return { ...receipt.source, selectedInputs: changedPaths.length ? 'changed' : 'unchanged', changedPaths };
  }
}
