import { execFile } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssessmentEngine } from './core.ts';
import { startServer } from './server.ts';
import type { AssessmentRun, CriterionStatus, TemplateVersion } from './types.ts';

const usage = `AssessmentFootprint — local software assessment with traceable evidence

Usage:
  assessment studio [projectPath] [--port N] [--no-open] [--data-dir PATH]
  assessment run [projectPath] [--criteria comma,list | --template ID [--template-version N]] [--online] [--json] [--data-dir PATH]
  assessment report RUN_ID --format html|json [--output FILE] [--data-dir PATH]
  assessment tools [--json]
  assessment templates list [--json] [--data-dir PATH]
  assessment templates show ID [--version N] [--json] [--data-dir PATH]
  assessment templates import FILE [--expected-version N] [--json] [--data-dir PATH]
  assessment templates export ID [--version N] [--output FILE] [--data-dir PATH]

Project path defaults to the current directory. Data defaults to .assessmentfootprint
in the current directory. One-off assessments run offline unless --online is supplied.
Template runs use their saved network profile; --online must agree with that profile.
Templates are versioned. Pin --template-version to reuse a particular version.
Importing an existing template ID requires its current local --expected-version.
Run exit codes: 0 satisfied, 1 negative result, 2 incomplete, 3 execution error.
`;

interface ParsedArguments {
  command: 'studio' | 'run' | 'report' | 'tools' | 'templates' | 'help';
  subcommand?: 'list' | 'show' | 'import' | 'export';
  positional: string[];
  options: Record<string, string | boolean>;
}

/** Parse only documented options; every value remains an argument, never shell code. */
export function parseArguments(args: string[]): ParsedArguments {
  if (!args.length || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    if (args.length > 1) throw new Error('The help command does not accept additional arguments.');
    return { command: 'help', positional: [], options: {} };
  }
  const command = args[0];
  if (command !== 'studio' && command !== 'run' && command !== 'report' && command !== 'tools' && command !== 'templates') {
    throw new Error(`Unknown command: ${command}. Use assessment --help.`);
  }
  const accepted: Record<Exclude<typeof command, 'templates'>, Record<string, 'value' | 'flag'>> = {
    studio: { '--port': 'value', '--no-open': 'flag', '--data-dir': 'value' },
    run: { '--criteria': 'value', '--template': 'value', '--template-version': 'value', '--online': 'flag', '--json': 'flag', '--data-dir': 'value' },
    report: { '--format': 'value', '--output': 'value', '--data-dir': 'value' },
    tools: { '--json': 'flag' },
  };
  const templateOptions: Record<NonNullable<ParsedArguments['subcommand']>, Record<string, 'value' | 'flag'>> = {
    list: { '--json': 'flag', '--data-dir': 'value' },
    show: { '--version': 'value', '--json': 'flag', '--data-dir': 'value' },
    import: { '--expected-version': 'value', '--json': 'flag', '--data-dir': 'value' },
    export: { '--version': 'value', '--output': 'value', '--data-dir': 'value' },
  };
  let subcommand: ParsedArguments['subcommand'];
  if (command === 'templates') {
    const action = args[1];
    if (action === '--help' || action === '-h') return { command: 'help', positional: [], options: {} };
    if (action !== 'list' && action !== 'show' && action !== 'import' && action !== 'export') throw new Error('Use templates list, show, import, or export.');
    subcommand = action;
  }
  const allowedOptions = command === 'templates' ? templateOptions[subcommand!] : accepted[command];
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  let positionalOnly = false;
  for (let index = command === 'templates' ? 2 : 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--' && !positionalOnly) { positionalOnly = true; continue; }
    if (!positionalOnly && (argument === '--help' || argument === '-h')) return { command: 'help', positional: [], options: {} };
    if (!positionalOnly && argument.startsWith('-')) {
      const kind = allowedOptions[argument];
      if (!kind) throw new Error(`Unknown option for ${command}: ${argument}.`);
      if (options[argument] !== undefined) throw new Error(`Option ${argument} was supplied more than once.`);
      if (kind === 'flag') options[argument] = true;
      else {
        const value = args[++index];
        if (value === undefined || value.startsWith('--') || !value.trim() || value.includes('\0')) {
          throw new Error(`Option ${argument} requires a value.`);
        }
        options[argument] = value;
      }
    } else {
      if (!argument.trim() || argument.includes('\0')) throw new Error('Arguments must not be empty.');
      positional.push(argument);
    }
  }
  const expected = command === 'tools' || command === 'templates' && subcommand === 'list' ? 0 : 1;
  if (positional.length > expected) throw new Error(`The ${command} command accepts at most ${expected} positional argument${expected === 1 ? '' : 's'}.`);
  if (command === 'report' && positional.length !== 1) throw new Error('The report command requires an assessment run identifier.');
  if (command === 'templates' && subcommand !== 'list' && positional.length !== 1) throw new Error(`The templates ${subcommand} command requires ${subcommand === 'import' ? 'a JSON file' : 'a template identifier'}.`);
  if (command === 'report' && options['--format'] !== 'html' && options['--format'] !== 'json') throw new Error('Report --format must be html or json.');
  if (options['--port'] !== undefined) {
    const value = options['--port'] as string;
    if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('--port must be an integer between 0 and 65535.');
  }
  if (options['--criteria'] !== undefined && (options['--criteria'] as string).split(',').some(id => !id.trim())) {
    throw new Error('--criteria requires comma-separated criterion identifiers without empty entries.');
  }
  if (options['--template'] !== undefined && options['--criteria'] !== undefined) throw new Error('Select --template or --criteria; they cannot be combined.');
  if (options['--template-version'] !== undefined && options['--template'] === undefined) throw new Error('--template-version requires --template.');
  for (const option of ['--version', '--template-version', '--expected-version']) {
    if (options[option] !== undefined) {
      const value = options[option] as string;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${option} must be a positive integer.`);
    }
  }
  return { command, ...(subcommand ? { subcommand } : {}), positional, options };
}

export function runExitCode(run: AssessmentRun): number {
  if (run.results.some(result => result.status === 'evaluation_error')) return 3;
  if (run.results.some(result => result.status === 'not_satisfied')) return 1;
  if (run.status === 'awaiting_review' || run.status === 'running' || run.status === 'interrupted' || run.results.some(result => result.status === 'insufficient_evidence')) return 2;
  return 0;
}

const statusLabels: Record<CriterionStatus, string> = {
  satisfied: 'Satisfied', not_satisfied: 'Not satisfied', insufficient_evidence: 'Needs evidence', not_applicable: 'Not applicable', evaluation_error: 'Evaluation error',
};

function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => execFile(command, args, error => error ? reject(error) : resolve()));
}

function templateFile(path: string): unknown {
  const limit = 64 * 1024;
  if (!statSync(path).isFile()) throw new Error('Template import requires a regular JSON file.');
  const descriptor = openSync(path, 'r');
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error('Template import requires a regular JSON file.');
    if (info.size > limit) throw new Error('Template file exceeds 64 KB.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!bytes) break;
      length += bytes;
    }
    if (length > limit) throw new Error('Template file exceeds 64 KB.');
    try { return JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { throw new Error('Template file must contain valid JSON.'); }
  } finally { closeSync(descriptor); }
}

function requiredTemplate(engine: AssessmentEngine, id: string, version?: number): TemplateVersion {
  const template = engine.getTemplate(id, version);
  if (!template) throw new Error('Assessment template or version was not found.');
  return template;
}

function writeOutput(contents: string, output: string | boolean | undefined, label: string): void {
  if (typeof output === 'string') {
    const outputPath = resolve(output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, contents, 'utf8');
    process.stdout.write(`${label} saved to ${outputPath}\n`);
  } else process.stdout.write(`${contents}\n`);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let engine: AssessmentEngine | undefined;
  try {
    const { command, subcommand, positional, options } = parseArguments(args);
    if (command === 'help') { process.stdout.write(usage); return 0; }
    const dataDir = resolve(typeof options['--data-dir'] === 'string' ? options['--data-dir'] : '.assessmentfootprint');
    engine = new AssessmentEngine({ dataDir });
    if (command === 'templates') {
      if (subcommand === 'list') {
        const templates = engine.listTemplates();
        if (options['--json']) process.stdout.write(`${JSON.stringify(templates, null, 2)}\n`);
        else {
          if (!templates.length) process.stdout.write('No assessment templates have been saved.\n');
          for (const template of templates) process.stdout.write(`${template.name} (${template.id}) — version ${template.latestVersion}\n  ${template.description}\n`);
        }
      } else if (subcommand === 'import') {
        let document = templateFile(resolve(positional[0]));
        if (typeof options['--expected-version'] === 'string') {
          if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Template file must contain a JSON object.');
          document = { ...document, expectedVersion: Number(options['--expected-version']) };
        }
        const template = engine.importTemplate(document);
        if (options['--json']) process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
        else process.stdout.write(`Imported ${template.name} (${template.id}) — version ${template.version}\n`);
      } else {
        const template = requiredTemplate(engine, positional[0], typeof options['--version'] === 'string' ? Number(options['--version']) : undefined);
        if (subcommand === 'export') writeOutput(JSON.stringify(template), options['--output'], 'Template');
        else if (options['--json']) process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
        else {
          process.stdout.write(`${template.name} (${template.id})\nVersion: ${template.version}\nNetwork profile: ${template.networkMode}\nPolicy digest: ${template.policyDigest}\n${template.description}\n\n`);
          for (const criterion of template.criteria) process.stdout.write(`${criterion.title} (${criterion.id})\n  ${criterion.rule}\n  Collector: ${criterion.collector.toolId}; paths: ${criterion.collector.paths.join(', ') || 'none'}\n`);
        }
      }
      return 0;
    }
    if (command === 'tools') {
      const tools = await engine.getTools();
      if (options['--json']) process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      else for (const tool of tools) {
        process.stdout.write(`${tool.available ? 'Available' : 'Missing'}: ${tool.name}${tool.version ? ` (${tool.version})` : ''}\n`);
        process.stdout.write(`  ${tool.description}\n`);
        if (!tool.available) for (const instruction of tool.setupInstructions) process.stdout.write(`  ${instruction}\n`);
      }
      return 0;
    }
    if (command === 'report') {
      const format = options['--format'] as 'html' | 'json';
      const report = engine.exportReport(positional[0], format);
      writeOutput(report, options['--output'], 'Report');
      return 0;
    }
    const projectPath = resolve(positional[0] ?? '.');
    if (command === 'run') {
      const templateId = typeof options['--template'] === 'string' ? options['--template'] : undefined;
      const run = await engine.runAssessment({ projectPath, criterionIds: typeof options['--criteria'] === 'string' ? [...new Set(options['--criteria'].split(',').map(id => id.trim()))] : undefined, templateId, templateVersion: typeof options['--template-version'] === 'string' ? Number(options['--template-version']) : undefined, networkMode: options['--online'] ? 'online' : templateId ? undefined : 'offline' });
      if (options['--json']) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      else {
        process.stdout.write(`Assessment ${run.id}\nProject: ${run.subject.path}\nStatus: ${run.status}\n\n`);
        if (run.template) process.stdout.write(`Template: ${run.template.name} — version ${run.template.version}\n\n`);
        for (const result of run.results) process.stdout.write(`${statusLabels[result.status]} — ${result.criterionId}\n  ${result.rationale}\n`);
        process.stdout.write(`\nEvidence and review history: ${dataDir}\n`);
      }
      return runExitCode(run);
    }
    await engine.inspectProject(projectPath);
    const app = await startServer({ engine, projectPath, dataDir, port: typeof options['--port'] === 'string' ? Number(options['--port']) : undefined });
    process.stdout.write(`AssessmentFootprint Studio\nProject: ${projectPath}\nOpen ${app.url}\nPress Ctrl+C to stop.\n`);
    if (!options['--no-open']) {
      void openBrowser(app.url).catch(() => process.stderr.write(`The browser could not be opened automatically. Open ${app.url}\n`));
    }
    await new Promise<void>((resolve, reject) => {
      const stop = () => { void app.close().then(resolve, reject); };
      const onError = (error: Error) => { void app.close().then(() => reject(error), reject); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      app.server.once('error', onError);
      app.server.once('close', () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        app.server.off('error', onError);
        resolve();
      });
    });
    return 0;
  } catch (error) {
    process.stderr.write(`AssessmentFootprint: ${error instanceof Error ? error.message : 'An unexpected error occurred.'}\n`);
    return 3;
  } finally {
    engine?.close();
  }
}

const thisModule = fileURLToPath(import.meta.url);
const executable = process.argv[1];
let executablePath: string | undefined;
try { if (executable) executablePath = realpathSync(executable); } catch { /* A library import has no executable path. */ }
if (executablePath === thisModule || executablePath === fileURLToPath(new URL('../bin/assessment.mjs', import.meta.url))) {
  process.exitCode = await main();
}
