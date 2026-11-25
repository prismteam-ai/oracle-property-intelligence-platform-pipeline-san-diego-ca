import path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

export interface OraclePipelineStackProps extends cdk.StackProps {
  projectName: string;
  /** Folder in the mirror bucket holding the run to serve, e.g. `san-diego/run-0003`. */
  artifactPrefix: string;
}

/**
 * The Oracle's whole hosted footprint: one mirror bucket and one function. Nothing runs between
 * requests, so with no traffic the cost is storage for about 170 MB (well under one cent a month).
 */
export class OraclePipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OraclePipelineStackProps) {
    super(scope, id, {
      ...props,
      env: { region: 'us-east-2', account: props.env?.account },
      tags: { project_name: props.projectName },
    });

    // Private cache of the published snapshot. IPFS CIDs are the identity; this bucket only
    // saves the function a slow gateway fetch, and the function re-checks every digest.
    const mirror = new s3.Bucket(this, 'ArtifactMirror', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const logGroup = new logs.LogGroup(this, 'McpLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mcp = new lambda.Function(this, 'McpHandler', {
      code: lambda.Code.fromAsset(path.resolve('dist/lambda')),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 3008,
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'oracle-pipeline-mcp',
        POWERTOOLS_METRICS_NAMESPACE: 'OraclePipeline',
        ARTIFACT_BUCKET: mirror.bucketName,
        ARTIFACT_PREFIX: props.artifactPrefix,
        HOME: '/tmp',
      },
    });
    mirror.grantRead(mcp);

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${props.projectName}-api`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowHeaders: ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id'],
        maxAge: cdk.Duration.hours(1),
      },
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('McpIntegration', mcp),
    });

    // One self-resolving alarm on function errors, fanned out through SNS. In a company account
    // PagerDuty (Events API v2) subscribes to this topic; this exercise account has no PagerDuty.
    const alarmTopic = new sns.Topic(this, 'CriticalAlarms');
    const errors = new cloudwatch.Alarm(this, 'McpErrors', {
      metric: mcp.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Oracle MCP function raised an unhandled error',
    });
    errors.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    errors.addOkAction(new cwActions.SnsAction(alarmTopic));

    new cdk.CfnOutput(this, 'McpUrl', { value: `${httpApi.apiEndpoint}/mcp` });
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'MirrorBucket', { value: mirror.bucketName });
  }
}
