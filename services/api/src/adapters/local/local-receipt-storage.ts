import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { UploadedReceipt } from '@claimflow/domain';

import type { ReceiptStorage } from '../../application/ports.js';
import { isMissingFile } from './json-database.js';

const receiptIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Stores each receipt as `<id>.bin` with its metadata in `<id>.json`. IDs are
 * validated before use so a path can never escape the receipts directory.
 */
export class LocalReceiptStorage implements ReceiptStorage {
  public constructor(private readonly directory: string) {}

  public async save(
    receipt: UploadedReceipt,
    content: Uint8Array,
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path(receipt.receiptId, 'bin'), content, {
      flag: 'wx',
    });
    await this.writeMetadata(receipt);
  }

  public async getMetadata(
    receiptId: string,
  ): Promise<UploadedReceipt | undefined> {
    if (!receiptIdPattern.test(receiptId)) {
      return undefined;
    }
    const text = await readIfExists(this.path(receiptId, 'json'), 'utf8');
    return text === undefined
      ? undefined
      : (JSON.parse(text) as UploadedReceipt);
  }

  public async read(receiptId: string): Promise<Uint8Array | undefined> {
    if (!receiptIdPattern.test(receiptId)) {
      return undefined;
    }
    return readIfExists(this.path(receiptId, 'bin'));
  }

  public async markAttached(receiptId: string, claimId: string): Promise<void> {
    const metadata = await this.getMetadata(receiptId);
    if (metadata !== undefined) {
      await this.writeMetadata({ ...metadata, attachedClaimId: claimId });
    }
  }

  public async delete(receiptId: string): Promise<void> {
    if (!receiptIdPattern.test(receiptId)) {
      return;
    }
    await rm(this.path(receiptId, 'json'), { force: true });
    await rm(this.path(receiptId, 'bin'), { force: true });
  }

  public async deleteUnattachedBefore(instant: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissingFile(error)) {
        return 0;
      }
      throw error;
    }

    let deleted = 0;
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const metadata = await this.getMetadata(name.slice(0, -'.json'.length));
      if (
        metadata !== undefined &&
        metadata.attachedClaimId === undefined &&
        metadata.uploadedAt < instant
      ) {
        await this.delete(metadata.receiptId);
        deleted += 1;
      }
    }
    return deleted;
  }

  private async writeMetadata(receipt: UploadedReceipt): Promise<void> {
    await writeFile(
      this.path(receipt.receiptId, 'json'),
      JSON.stringify(receipt, null, 2),
      'utf8',
    );
  }

  private path(receiptId: string, extension: 'bin' | 'json'): string {
    if (!receiptIdPattern.test(receiptId)) {
      throw new Error('Invalid receipt ID.');
    }
    return join(this.directory, `${receiptId}.${extension}`);
  }
}

async function readIfExists(path: string): Promise<Uint8Array | undefined>;
async function readIfExists(
  path: string,
  encoding: 'utf8',
): Promise<string | undefined>;
async function readIfExists(
  path: string,
  encoding?: 'utf8',
): Promise<Uint8Array | string | undefined> {
  try {
    return encoding === undefined
      ? new Uint8Array(await readFile(path))
      : await readFile(path, encoding);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}
