import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssessmentEngine } from './core.ts';
import { startServer } from './server.ts';
import type { AssessmentRun, CriterionStatus } from './types.ts';

const usage = `AssessmentFootprint — local software assessment with traceable evidence

Usage:
  assessment studio [projectPath] [--port N] [--no-open] [--data-dir PATH]
  assessment run [projectPath] [--criteria comma,list] [--online] [--json] [--data-dir PATH]
  assessment report RUN_ID --format html|json [--output FILE] [--data-dir PATH]
  assessment tools [--json]

Project path defaults to the current directory. Data defaults to .assessmentfootprint
in the current directory. Assessments run offline unless --online is supplied.
Run exit codes: 0 satisfied, 1 negative result, 2 incomplete, 3 execution error.
`;

interface ParsedArguments {
  command: 'studio' | 'run' | 'report' | 'tools' | 'help';
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
  if (command !== 'studio' && command !== 'run' && command !== 'report' && command !== 'tools') {
    throw new Error(`Unknown command: ${command}. Use assessment --help.`);
  }
  const accepted: Record<typeof command, Record<string, 'value' | 'flag'>> = {
    studio: { '--port': 'value', '--no-open': 'flag', '--data-dir': 'value' },
    run: { '--criteria': 'value', '--online': 'flag', '--json': 'flag', '--data-dir': 'value' },
    report: { '--format': 'value', '--output': 'value', '--data-dir': 'value' },
    tools: { '--json': 'flag' },
  };
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  let positionalOnly = false;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--' && !positionalOnly) { positionalOnly = true; continue; }
    if (!positionalOnly && (argument === '--help' || argument === '-h')) return { command: 'help', positional: [], options: {} };
    if (!positionalOnly && argument.startsWith('-')) {
      const kind = accepted[command][argument];
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
  const expected = command === 'tools' ? 0 : 1;
  if (positional.length > expected) throw new Error(`The ${command} command accepts at most ${expected} positional argument${expected === 1 ? '' : 's'}.`);
  if (command === 'report' && positional.length !== 1) throw new Error('The report command requires an assessment run identifier.');
  if (command === 'report' && options['--format'] !== 'html' && options['--format'] !== 'json') throw new Error('Report --format must be html or json.');
  if (options['--port'] !== undefined) {
    const value = options['--port'] as string;
    if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('--port must be an integer between 0 and 65535.');
  }
  if (options['--criteria'] !== undefined && (options['--criteria'] as string).split(',').some(id => !id.trim())) {
    throw new Error('--criteria requires comma-separated criterion identifiers without empty entries.');
  }
  return { command, positional, options };
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

export async function main(args = process.argv.slice(2)): Promise<number> {
  let engine: AssessmentEngine | undefined;
  try {
    const { command, positional, options } = parseArguments(args);
    if (command === 'help') { process.stdout.write(usage); return 0; }
    const dataDir = resolve(typeof options['--data-dir'] === 'string' ? options['--data-dir'] : '.assessmentfootprint');
    engine = new AssessmentEngine({ dataDir });
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
      if (typeof options['--output'] === 'string') {
        const outputPath = resolve(options['--output']);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, report, 'utf8');
        process.stdout.write(`Report saved to ${outputPath}\n`);
      } else process.stdout.write(`${report}\n`);
      return 0;
    }
    const projectPath = resolve(positional[0] ?? '.');
    if (command === 'run') {
      const run = await engine.runAssessment({ projectPath, criterionIds: typeof options['--criteria'] === 'string' ? [...new Set(options['--criteria'].split(',').map(id => id.trim()))] : undefined, networkMode: options['--online'] ? 'online' : 'offline' });
      if (options['--json']) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      else {
        process.stdout.write(`Assessment ${run.id}\nProject: ${run.subject.path}\nStatus: ${run.status}\n\n`);
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
