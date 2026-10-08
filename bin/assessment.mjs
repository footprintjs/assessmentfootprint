#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional tools belong to this trusted application installation, never to the assessed folder.
const toolsDirectory = fileURLToPath(new URL('../.tools/', import.meta.url));
const scanner = join(toolsDirectory, 'bin', process.platform === 'win32' ? 'osv-scanner.exe' : 'osv-scanner');
if (existsSync(scanner)) process.env.PATH = `${join(toolsDirectory, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
if (!process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY && existsSync(join(toolsDirectory, 'osv-db'))) {
  process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY = join(toolsDirectory, 'osv-db');
}
await import('../src/cli.ts');
