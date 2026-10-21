import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError, parseRuntimeConfig } from '../src/config';
import {
  immutableCacheControl,
  parseInputs,
  planCaching,
  release,
  renderConfig,
  revalidateCacheControl,
  type ReleaseInputs,
} from '../scripts/release';

const inputs: ReleaseInputs = {
  apiBaseUrl: 'https://abc123.execute-api.ap-southeast-1.amazonaws.com/api/v1/',
  hostedUiUrl: 'https://claimflow-1.auth.ap-southeast-1.amazoncognito.com/',
  clientId: 'client123abc',
};

describe('parseInputs', () => {
  const argv = [
    '--api-base-url',
    'https://api.example.com/api/v1',
    '--hosted-ui-url=https://auth.example.com',
    '--client-id',
    'abc',
  ];

  it('reads flags in both forms', () => {
    expect(parseInputs(argv, {})).toEqual({
      apiBaseUrl: 'https://api.example.com/api/v1',
      hostedUiUrl: 'https://auth.example.com',
      clientId: 'abc',
    });
  });

  it('falls back to the environment, with flags taking precedence', () => {
    const env = {
      CLAIMFLOW_WEB_API_BASE_URL: 'https://env.example.com/api/v1',
      CLAIMFLOW_WEB_HOSTED_UI_URL: 'https://envauth.example.com',
      CLAIMFLOW_WEB_CLIENT_ID: 'envclient',
    };
    expect(parseInputs(['--client-id', 'flagclient'], env)).toEqual({
      apiBaseUrl: 'https://env.example.com/api/v1',
      hostedUiUrl: 'https://envauth.example.com',
      clientId: 'flagclient',
    });
  });

  it('has no defaults: every missing input is named', () => {
    expect(() => parseInputs(['--client-id', 'abc'], {})).toThrow(
      /Missing --api-base-url, --hosted-ui-url\./,
    );
    expect(() => parseInputs([], { CLAIMFLOW_WEB_CLIENT_ID: '  ' })).toThrow(
      /Missing --api-base-url, --hosted-ui-url, --client-id/,
    );
  });

  it('rejects unknown arguments and flags without a value', () => {
    expect(() => parseInputs([...argv, '--bucket', 'x'], {})).toThrow(
      /Unknown argument --bucket/,
    );
    expect(() => parseInputs(['--client-id'], {})).toThrow(/needs a value/);
  });
});

describe('renderConfig', () => {
  it('writes only the three validated values, normalized', () => {
    const text = renderConfig(inputs);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      apiBaseUrl:
        'https://abc123.execute-api.ap-southeast-1.amazonaws.com/api/v1',
      cognito: {
        hostedUiUrl:
          'https://claimflow-1.auth.ap-southeast-1.amazoncognito.com',
        clientId: 'client123abc',
      },
    });
    // The runtime accepts exactly what the release writes.
    expect(() => parseRuntimeConfig(JSON.parse(text))).not.toThrow();
  });

  it('is deterministic', () => {
    expect(renderConfig(inputs)).toBe(renderConfig({ ...inputs }));
  });

  it.each([
    ['a relative API URL', { apiBaseUrl: '/api/v1' }],
    ['a plain http API URL', { apiBaseUrl: 'http://api.example.com/api/v1' }],
    ['an API URL with a query', { apiBaseUrl: 'https://a.example.com/x?y=1' }],
    ['an http hosted UI', { hostedUiUrl: 'http://auth.example.com' }],
    ['a hosted UI with a path', { hostedUiUrl: 'https://auth.example.com/x' }],
    ['a client ID with a space', { clientId: 'a b' }],
    ['an empty client ID', { clientId: '' }],
  ])('rejects %s', (_name, override) => {
    expect(() => renderConfig({ ...inputs, ...override })).toThrow(ConfigError);
  });
});

describe('planCaching', () => {
  const files = [
    'index.html',
    'config.json',
    'THIRD_PARTY_NOTICES.txt',
    'favicon.svg',
    'assets/index-DAbc1234.js',
    'assets/index-9xYz_-12.css',
  ];

  it('makes hashed assets immutable and everything else revalidate', () => {
    const plan = Object.fromEntries(
      planCaching(files).map((file) => [file.path, file.cacheControl]),
    );
    expect(plan).toEqual({
      'index.html': revalidateCacheControl,
      'config.json': revalidateCacheControl,
      'THIRD_PARTY_NOTICES.txt': revalidateCacheControl,
      'favicon.svg': revalidateCacheControl,
      'assets/index-DAbc1234.js': immutableCacheControl,
      'assets/index-9xYz_-12.css': immutableCacheControl,
    });
    expect(immutableCacheControl).toBe('public, max-age=31536000, immutable');
    expect(revalidateCacheControl).toMatch(/no-cache/);
  });

  it('never makes index.html or config.json cacheable', () => {
    for (const name of ['index.html', 'config.json']) {
      const entry = planCaching(files).find((file) => file.path === name);
      expect(entry?.cacheControl).not.toMatch(/immutable|max-age=[1-9]/);
    }
  });

  it('refuses an unhashed asset', () => {
    expect(() => planCaching([...files, 'assets/logo.png'])).toThrow(
      /not content-hashed/,
    );
  });

  it.each(['index.html', 'config.json', 'THIRD_PARTY_NOTICES.txt'])(
    'requires %s',
    (missing) => {
      expect(() =>
        planCaching(files.filter((file) => file !== missing)),
      ).toThrow(missing);
    },
  );
});

describe('release', () => {
  let root: string;
  let distDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'claimflow-release-'));
    distDir = path.join(root, 'dist');
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  const exists = (target: string) =>
    stat(target).then(
      () => true,
      () => false,
    );

  /** Stands in for Vite: empties nothing itself, as release clears dist first. */
  const fakeBuild = vi.fn(async () => {
    await mkdir(path.join(distDir, 'assets'), { recursive: true });
    await writeFile(path.join(distDir, 'index.html'), '<!doctype html>');
    await writeFile(path.join(distDir, 'THIRD_PARTY_NOTICES.txt'), 'notices');
    await writeFile(path.join(distDir, 'assets', 'index-DAbc1234.js'), '//');
  });

  it('builds, then writes config.json next to index.html', async () => {
    const result = await release({ inputs, distDir, build: fakeBuild });

    expect(fakeBuild).toHaveBeenCalledTimes(1);
    const written = await readFile(path.join(distDir, 'config.json'), 'utf8');
    expect(written).toBe(result.config);
    expect(written).toBe(renderConfig(inputs));
    expect(result.files.map((file) => file.path)).toEqual([
      'THIRD_PARTY_NOTICES.txt',
      'assets/index-DAbc1234.js',
      'config.json',
      'index.html',
    ]);
  });

  it('writes the same bytes for the same inputs', async () => {
    await release({ inputs, distDir, build: fakeBuild });
    const first = await readFile(path.join(distDir, 'config.json'));
    await release({ inputs, distDir, build: fakeBuild });
    expect(await readFile(path.join(distDir, 'config.json'))).toEqual(first);
  });

  it('replaces a stale config.json from an earlier release', async () => {
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, 'config.json'), '{"old":true}');
    await release({ inputs, distDir, build: fakeBuild });
    expect(await readFile(path.join(distDir, 'config.json'), 'utf8')).toBe(
      renderConfig(inputs),
    );
  });

  it('fails on invalid inputs before building and leaves no dist', async () => {
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, 'index.html'), 'old build');
    const build = vi.fn();

    await expect(
      release({
        inputs: { ...inputs, hostedUiUrl: 'http://auth.example.com' },
        distDir,
        build,
      }),
    ).rejects.toBeInstanceOf(ConfigError);

    expect(build).not.toHaveBeenCalled();
    expect(await exists(distDir)).toBe(false);
  });

  it('leaves no dist when the build fails', async () => {
    const build = vi.fn(async () => {
      await mkdir(distDir, { recursive: true });
      await writeFile(path.join(distDir, 'index.html'), 'partial');
      throw new Error('build failed');
    });
    await expect(release({ inputs, distDir, build })).rejects.toThrow(
      'build failed',
    );
    expect(await exists(distDir)).toBe(false);
  });

  it('leaves no dist when the build output has no third-party notices', async () => {
    const build = async () => {
      await mkdir(path.join(distDir, 'assets'), { recursive: true });
      await writeFile(path.join(distDir, 'index.html'), 'x');
    };
    await expect(release({ inputs, distDir, build })).rejects.toThrow(
      'THIRD_PARTY_NOTICES.txt',
    );
    expect(await exists(distDir)).toBe(false);
  });

  it('leaves no dist when the output cannot be cached safely', async () => {
    const build = async () => {
      await mkdir(path.join(distDir, 'assets'), { recursive: true });
      await writeFile(path.join(distDir, 'index.html'), 'x');
      await writeFile(path.join(distDir, 'THIRD_PARTY_NOTICES.txt'), 'x');
      await writeFile(path.join(distDir, 'assets', 'logo.png'), 'x');
    };
    await expect(release({ inputs, distDir, build })).rejects.toThrow(
      /not content-hashed/,
    );
    expect(await exists(distDir)).toBe(false);
  });
});
