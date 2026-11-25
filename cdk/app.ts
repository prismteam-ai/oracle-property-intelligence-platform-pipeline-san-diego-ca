import * as cdk from 'aws-cdk-lib';
import { OraclePipelineStack } from './stack.js';

const app = new cdk.App();
const artifactPrefix =
  (app.node.tryGetContext('artifactPrefix') as string | undefined) ?? 'san-diego/current';

// The key is left out, not set to undefined, when the account is unknown (exactOptionalPropertyTypes).
const account = process.env['CDK_DEFAULT_ACCOUNT'];

new OraclePipelineStack(app, 'OraclePipelineStack', {
  projectName: 'oracle-pipeline-san-diego',
  artifactPrefix,
  agentKeyParameter:
    (app.node.tryGetContext('agentKeyParameter') as string | undefined) ??
    '/oracle-pipeline/anthropic-api-key',
  env: { region: 'us-east-2', ...(account === undefined ? {} : { account }) },
});
