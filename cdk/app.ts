import * as cdk from 'aws-cdk-lib';
import { OraclePipelineStack } from './stack.js';

const app = new cdk.App();
const artifactPrefix =
  (app.node.tryGetContext('artifactPrefix') as string | undefined) ?? 'san-diego/current';

new OraclePipelineStack(app, 'OraclePipelineStack', {
  projectName: 'oracle-pipeline-san-diego',
  artifactPrefix,
  env: { account: process.env['CDK_DEFAULT_ACCOUNT'], region: 'us-east-2' },
});
