import type { Actor } from './actor.js';
import type { Violation } from './errors.js';

export const receiptContentTypes = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

export type ReceiptContentType = (typeof receiptContentTypes)[number];

export const maxReceiptSizeBytes = 10 * 1024 * 1024;

const fileNameMaxLength = 120;
const checksumPattern = /^[a-f0-9]{64}$/;

/** Receipt metadata recorded on a claim. Storage-neutral by design. */
export interface Receipt {
  readonly receiptId: string;
  readonly fileName: string;
  readonly contentType: ReceiptContentType;
  readonly sizeBytes: number;
  /** Lower-case hex SHA-256 digest of the file contents. */
  readonly checksumSha256: string;
  readonly attachedAt: string;
}

/** A stored upload, as measured by the server, before or after attachment. */
export interface UploadedReceipt {
  readonly receiptId: string;
  readonly ownerId: string;
  readonly fileName: string;
  readonly contentType: ReceiptContentType;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly uploadedAt: string;
  readonly attachedClaimId?: string;
}

/** What the client says it uploaded; checked against the stored upload. */
export interface ReceiptDeclaration {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

export function isReceiptContentType(
  value: string,
): value is ReceiptContentType {
  return (receiptContentTypes as readonly string[]).includes(value);
}

export function isChecksumSha256(value: string): boolean {
  return checksumPattern.test(value);
}

/**
 * Reduces a client-supplied file name to a safe display name: no directories,
 * control characters, or characters that are unsafe in file systems or headers.
 */
export function sanitizeFileName(name: string): string {
  const baseName = name.split(/[/\\]/).pop() ?? '';
  const cleaned = baseName
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*;]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return cleaned.slice(0, fileNameMaxLength) || 'receipt';
}

/** Identifies a supported file type from its leading bytes. */
export function detectReceiptContentType(
  bytes: Uint8Array,
): ReceiptContentType | undefined {
  const startsWith = (signature: readonly number[]) =>
    signature.every((byte, index) => bytes[index] === byte);

  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'application/pdf'; // %PDF-
  }
  if (startsWith([0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  return undefined;
}

export function validateReceiptFile(file: {
  readonly contentType: string;
  readonly sizeBytes: number;
}): readonly Violation[] {
  const violations: Violation[] = [];
  if (!isReceiptContentType(file.contentType)) {
    violations.push({
      field: 'contentType',
      code: 'INVALID_RECEIPT_TYPE',
      message: 'Receipts must be PDF, JPEG, or PNG files.',
    });
  }
  if (
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 0 ||
    file.sizeBytes > maxReceiptSizeBytes
  ) {
    violations.push({
      field: 'sizeBytes',
      code: 'INVALID_RECEIPT_SIZE',
      message: 'Receipts must be between 1 byte and 10 MB.',
    });
  }
  return violations;
}

/**
 * Checks that an upload may be attached to a claim by this actor and that the
 * client's declaration matches what the server actually stored.
 */
export function verifyReceiptForAttachment(
  upload: UploadedReceipt,
  declaration: ReceiptDeclaration,
  claim: { readonly claimId: string; readonly employeeId: string },
  actor: Actor,
): readonly Violation[] {
  if (
    upload.ownerId !== actor.userId ||
    upload.ownerId !== claim.employeeId ||
    (upload.attachedClaimId !== undefined &&
      upload.attachedClaimId !== claim.claimId)
  ) {
    return [
      {
        field: 'receiptId',
        code: 'RECEIPT_UNAVAILABLE',
        message: 'The receipt does not exist or cannot be attached.',
      },
    ];
  }

  const violations: Violation[] = [...validateReceiptFile(upload)];
  if (!isChecksumSha256(declaration.checksumSha256)) {
    violations.push({
      field: 'checksumSha256',
      code: 'INVALID_CHECKSUM',
      message: 'Checksum must be a lower-case hex SHA-256 digest.',
    });
  } else if (declaration.checksumSha256 !== upload.checksumSha256) {
    violations.push(mismatch('checksumSha256'));
  }
  if (declaration.sizeBytes !== upload.sizeBytes) {
    violations.push(mismatch('sizeBytes'));
  }
  if (declaration.contentType !== upload.contentType) {
    violations.push(mismatch('contentType'));
  }
  return violations;
}

function mismatch(field: string): Violation {
  return {
    field,
    code: 'RECEIPT_MISMATCH',
    message: 'The receipt metadata does not match the uploaded file.',
  };
}
