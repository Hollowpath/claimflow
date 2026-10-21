import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin } from 'vite';

export const noticesFileName = 'THIRD_PARTY_NOTICES.txt';

/** Directories of the npm packages that the given bundled module ids come from. */
export function packageRootsOf(moduleIds: Iterable<string>): string[] {
  const roots = new Set<string>();
  const marker = 'node_modules/';
  for (const id of moduleIds) {
    const normalized = id.split('\\').join('/').replace(/^\0/, '');
    const index = normalized.lastIndexOf(marker);
    if (index < 0) {
      continue;
    }
    const parts = normalized.slice(index + marker.length).split('/');
    const name = parts[0]?.startsWith('@')
      ? `${parts[0]}/${parts[1]}`
      : parts[0];
    if (name !== undefined && name !== '') {
      roots.add(`${normalized.slice(0, index)}${marker}${name}`);
    }
  }
  return [...roots].sort();
}

/** The `package@version` entries that the notices file lists for the web build. */
export function listedWebPackages(notices: string): Set<string> {
  const listed = new Set<string>();
  for (const line of notices.split('\n')) {
    const match = /^(\S+@\S+)\s+\S+\s+(?:lambda, )?web\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      listed.add(match[1]);
    }
  }
  return listed;
}

/** Bundled `package@version` values that the notices file does not list. */
export function missingFromNotices(
  moduleIds: Iterable<string>,
  notices: string,
  readVersion: (packageRoot: string) => string = (root) =>
    (
      JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version,
): string[] {
  const listed = listedWebPackages(notices);
  return packageRootsOf(moduleIds)
    .map((root) => {
      const name = root.slice(root.lastIndexOf('node_modules/') + 13);
      return `${name}@${readVersion(root)}`;
    })
    .filter((entry) => !listed.has(entry));
}

/**
 * Checks, in every real build, that the repository's third-party notices list
 * each npm package Rollup bundled, then adds the notices file to the output.
 * A missing entry fails the build and names the `package@version` values.
 */
export function thirdPartyNotices(noticesPath: string): Plugin {
  return {
    name: 'claimflow-third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const notices = readFileSync(noticesPath, 'utf8');
      const moduleIds = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' ? Object.keys(output.modules) : [],
      );
      const missing = missingFromNotices(moduleIds, notices);
      if (missing.length > 0) {
        this.error(
          `${noticesFileName} does not list the bundled package(s): ${missing.join(', ')}. Add their notices before building.`,
        );
      }
      this.emitFile({
        type: 'asset',
        fileName: noticesFileName,
        source: notices,
      });
    },
  };
}
