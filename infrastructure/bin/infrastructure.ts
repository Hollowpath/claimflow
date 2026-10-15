#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CLAIMFLOW_REGION, ClaimFlowStack } from '../lib/claimflow-stack';

const app = new cdk.App();

new ClaimFlowStack(app, 'ClaimFlow', {
  env: {
    // The account of the credentials the CDK CLI is running with.
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: CLAIMFLOW_REGION,
  },
});
