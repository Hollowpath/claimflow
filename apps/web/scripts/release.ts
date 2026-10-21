/**
 * Builds the web application for a deployment and writes its `config.json`.
 * It only writes files under `dist/`; publishing is a manual step (see
 * infrastructure/README.md). Run with `npm run release -w @claimflow/web`.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigError, parseRuntimeConfig } from '../src/config';

export interface ReleaseInputs {
  /** The stack's `ApiBaseUrl` output. */
  readonly apiBaseUrl: string;
  /** The Cognito domain base URL (an https origin). */
  readonly hostedUiUrl: string;
  /** The `ClaimFlowWeb` app client ID. */
  readonly clientId: string;
}

/** Flag, environment variable, and input name of each required value. */
const inputSpecs = [
  ['--api-base-url', 'CLAIMFLOW_WEB_API_BASE_URL', 'apiBaseUrl'],
  ['--hosted-ui-url', 'CLAIMFLOW_WEB_HOSTED_UI_URL', 'hostedUiUrl'],
  ['--client-id', 'CLAIMFLOW_WEB_CLIENT_ID', 'clientId'],
] as const;

export const usage = `Usage: npm run release -w @claimflow/web -- ${inputSpecs
  .map(([flag]) => `${flag} <value>`)
  .join(' ')}
Each value may instead come from ${inputSpecs.map(([, env]) => env).join(', ')}.`;

/** Reads the three inputs from flags, falling back to the environment. */
export function parseInputs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ReleaseInputs {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const [name = '', inline] = argv[index]!.split(/=(.*)/s, 2);
    const known = inputSpecs.some(([flag]) => flag === name);
    if (!known) {
      throw new ConfigError(`Unknown argument ${argv[index]}.\n${usage}`);
    }
    const value = inline ?? argv[(index += 1)];
    if (value === undefined) {
      throw new ConfigError(`${name} needs a value.\n${usage}`);
    }
    flags.set(name, value);
  }
  const inputs: Record<string, string> = {};
  const missing: string[] = [];
  for (const [flag, variable, key] of inputSpecs) {
    const value = flags.get(flag) ?? env[variable];
    if (value === undefined || value.trim() === '') {
      missing.push(flag);
    } else {
      inputs[key] = value.trim();
    }
  }
  if (missing.length > 0) {
    throw new ConfigError(`Missing ${missing.join(', ')}.\n${usage}`);
  }
  return inputs as unknown as ReleaseInputs;
}

/** The exact text of `config.json`, validated with the runtime's own rules. */
export function renderConfig(inputs: ReleaseInputs): string {
  const config = parseRuntimeConfig({
    apiBaseUrl: inputs.apiBaseUrl,
    cognito: { hostedUiUrl: inputs.hostedUiUrl, clientId: inputs.clientId },
  });
  return `${JSON.stringify(config, null, 2)}\n`;
}

export const immutableCacheControl = 'public, max-age=31536000, immutable';
export const revalidateCacheControl = 'no-cache, max-age=0';

/** Vite names built assets `name-<hash>.ext`. */
const hashedAsset = /^assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

export interface CachedFile {
  readonly path: string;
  readonly cacheControl: string;
}

/**
 * The `Cache-Control` each published file needs. Only content-hashed files
 * under `assets/` may be immutable; everything else, `index.html` and
 * `config.json` included, must be revalidated on every use.
 */
export function planCaching(files: readonly string[]): CachedFile[] {
  for (const required of [
    'index.html',
    'config.json',
    'THIRD_PARTY_NOTICES.txt',
  ]) {
    if (!files.includes(required)) {
      throw new Error(`The release has no ${required}.`);
    }
  }
  return [...files].sort().map((file) => {
    if (!file.startsWith('assets/')) {
      return { path: file, cacheControl: revalidateCacheControl };
    }
    if (!hashedAsset.test(file)) {
      throw new Error(
        `${file} is not content-hashed, so it cannot be immutable.`,
      );
    }
    return { path: file, cacheControl: immutableCacheControl };
  });
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relative)));
    } else {
      files.push(relative);
    }
  }
  return files;
}

export interface ReleaseOptions {
  readonly inputs: ReleaseInputs;
  readonly distDir: string;
  /** Builds the application into `distDir`. */
  readonly build: () => Promise<void>;
}

/**
 * Validates the inputs, builds, and writes `config.json`. `dist/` is removed
 * first and again on any failure, so a failed run never leaves a directory
 * that could be published.
 */
export async function release({
  inputs,
  distDir,
  build,
}: ReleaseOptions): Promise<{
  readonly config: string;
  readonly files: CachedFile[];
}> {
  try {
    const config = renderConfig(inputs);
    await rm(distDir, { recursive: true, force: true });
    await build();
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, 'config.json'), config, 'utf8');
    return { config, files: planCaching(await listFiles(distDir)) };
  } catch (error) {
    await rm(distDir, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const webRoot = path.resolve(import.meta.dirname, '..');
  const inputs = parseInputs(process.argv.slice(2), process.env);
  const { build } = await import('vite');
  const { config, files } = await release({
    inputs,
    distDir: path.join(webRoot, 'dist'),
    build: async () => {
      await build({ root: webRoot, logLevel: 'warn' });
    },
  });
  console.log(`Built apps/web/dist with config.json:\n${config}`);
  console.log('Cache-Control for each file:');
  for (const file of files) {
    console.log(`  ${file.cacheControl.padEnd(38)} ${file.path}`);
  }
  console.log('Nothing was published. See infrastructure/README.md.');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
