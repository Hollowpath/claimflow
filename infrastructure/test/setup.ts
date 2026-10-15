import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll } from 'vitest';

// Synthesizing an App without an explicit outdir writes to temporary
// directories. Remove them after each test file, as the CDK Jest helper does.
if (!process.env.CDK_NO_CLEAN_TESTS) {
  afterAll(() => CloudAssembly.cleanupTemporaryDirectories());
}
