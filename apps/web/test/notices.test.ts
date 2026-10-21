import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Rollup } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listedWebPackages,
  missingFromNotices,
  noticesFileName,
  packageRootsOf,
  thirdPartyNotices,
} from '../scripts/notices';

const realNotices = path.resolve(
  process.cwd(),
  '../../THIRD_PARTY_NOTICES.txt',
);

const notices = [
  'react@19.3.0                       MIT          web',
  'zod@4.6.6                          MIT          lambda, web',
  '@aws-sdk/core@3.978.3              Apache-2.0   lambda',
  'bowser@2.14.1                      MIT          lambda',
].join('\n');

describe('packageRootsOf', () => {
  it('finds each package once, scoped and nested, on any path style', () => {
    expect(
      packageRootsOf([
        '/repo/node_modules/react/index.js',
        '/repo/node_modules/react/jsx-runtime.js',
        'C:\\repo\\node_modules\\@scope\\pkg\\lib\\a.js',
        '/repo/node_modules/a/node_modules/b/index.js',
        '\0/repo/node_modules/zod/v4/index.js?commonjs-module',
      ]),
    ).toEqual([
      '/repo/node_modules/a/node_modules/b',
      '/repo/node_modules/react',
      '/repo/node_modules/zod',
      'C:/repo/node_modules/@scope/pkg',
    ]);
  });

  it("ignores the project's own and virtual modules", () => {
    expect(
      packageRootsOf([
        '/repo/apps/web/src/main.tsx',
        '/repo/packages/contracts/src/index.ts',
        '\0vite/preload-helper.js',
      ]),
    ).toEqual([]);
  });
});

describe('listedWebPackages', () => {
  it('lists only the entries used by the web build', () => {
    expect([...listedWebPackages(notices)].sort()).toEqual([
      'react@19.3.0',
      'zod@4.6.6',
    ]);
  });
});

describe('missingFromNotices', () => {
  const versions: Record<string, string> = {
    '/r/node_modules/react': '19.3.0',
    '/r/node_modules/zod': '4.6.6',
    '/r/node_modules/left-pad': '1.0.0',
    '/r/node_modules/@scope/new': '2.0.0',
    '/r/node_modules/bowser': '2.14.1',
  };
  const readVersion = (root: string) => versions[root]!;

  it('is empty when every bundled package@version is listed', () => {
    expect(
      missingFromNotices(
        ['/r/node_modules/react/a.js', '/r/node_modules/zod/b.js'],
        notices,
        readVersion,
      ),
    ).toEqual([]);
  });

  it('names each unlisted package@version', () => {
    expect(
      missingFromNotices(
        [
          '/r/node_modules/react/a.js',
          '/r/node_modules/left-pad/i.js',
          '/r/node_modules/@scope/new/i.js',
        ],
        notices,
        readVersion,
      ),
    ).toEqual(['@scope/new@2.0.0', 'left-pad@1.0.0']);
  });

  it('rejects a listed package at a different version, or one only the Lambdas use', () => {
    expect(
      missingFromNotices(
        ['/r/node_modules/react/a.js'],
        notices,
        () => '19.4.0',
      ),
    ).toEqual(['react@19.4.0']);
    expect(
      missingFromNotices(['/r/node_modules/bowser/a.js'], notices, readVersion),
    ).toEqual(['bowser@2.14.1']);
  });
});

describe('thirdPartyNotices build plugin', () => {
  let root: string;
  let noticesPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'claimflow-notices-'));
    noticesPath = path.join(root, 'notices.txt');
    writeFileSync(noticesPath, notices);
    for (const [name, version] of [
      ['react', '19.3.0'],
      ['left-pad', '1.0.0'],
    ] as const) {
      mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
      writeFileSync(
        path.join(root, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, version }),
      );
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const bundleOf = (...modules: string[]) =>
    ({
      'index.js': {
        type: 'chunk',
        modules: Object.fromEntries(
          modules.map((name) => [
            path.join(root, 'node_modules', name, 'index.js'),
            {},
          ]),
        ),
      },
      'index.html': { type: 'asset' },
    }) as unknown as Rollup.OutputBundle;

  function run(bundle: Rollup.OutputBundle) {
    const emitFile = vi.fn();
    const error = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const plugin = thirdPartyNotices(noticesPath);
    expect(plugin.apply).toBe('build');
    const hook = plugin.generateBundle as (
      this: unknown,
      options: object,
      bundle: Rollup.OutputBundle,
    ) => void;
    hook.call({ emitFile, error }, {}, bundle);
    return emitFile;
  }

  it('emits the notices file when every bundled package is listed', () => {
    const emitFile = run(bundleOf('react'));
    expect(emitFile).toHaveBeenCalledExactlyOnceWith({
      type: 'asset',
      fileName: noticesFileName,
      source: notices,
    });
  });

  it('fails the build, naming the missing package@version, and emits nothing', () => {
    const emitFile = vi.fn();
    const hook = thirdPartyNotices(noticesPath).generateBundle as (
      this: unknown,
      options: object,
      bundle: Rollup.OutputBundle,
    ) => void;
    expect(() =>
      hook.call(
        {
          emitFile,
          error: (message: string) => {
            throw new Error(message);
          },
        },
        {},
        bundleOf('react', 'left-pad'),
      ),
    ).toThrow(/does not list the bundled package\(s\): left-pad@1\.0\.0/);
    expect(emitFile).not.toHaveBeenCalled();
  });
});

describe('the repository notices file', () => {
  it('states what it covers and keeps the license texts', () => {
    const text = readFileSync(realNotices, 'utf8');
    expect(text).toContain('THIRD-PARTY NOTICES FOR CLAIMFLOW');
    expect(listedWebPackages(text).has('react@19.3.0')).toBe(true);
    expect(text).toMatch(/Permission is hereby granted, free of charge/);
    expect(text).toMatch(/Apache License\s+Version 2\.0/);
    expect(text).toContain('covers only the packages bundled');
  });
});
