import path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

export interface OraclePipelineStackProps extends cdk.StackProps {
  projectName: string;
  /** Folder in the mirror bucket holding the run to serve, e.g. `san-diego/run-0003`. */
  artifactPrefix: string;
  /** SSM SecureString parameter holding the model API key for the agent endpoint. */
  agentKeyParameter?: string;
  /**
   * Repository whose `ingest` workflow may write to the mirror bucket; no role when unset. It is
   * the repository part of GitHub's OIDC subject: `owner/repo`, or `owner@id/repo@id` where the
   * repository uses immutable subjects (`gh api repos/OWNER/REPO/actions/oidc/customization/sub`).
   */
  ingestRepo?: string;
  /** Branch that workflow runs from. */
  ingestBranch?: string;
}

/**
 * The Oracle's whole hosted footprint: one mirror bucket and one function. Nothing runs between
 * requests, so with no traffic the cost is storage for about 170 MB (well under one cent a month).
 */
export class OraclePipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OraclePipelineStackProps) {
    super(scope, id, {
      ...props,
      env: {
        region: 'us-east-2',
        ...(props.env?.account === undefined ? {} : { account: props.env.account }),
      },
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
        ...(props.agentKeyParameter ? { AGENT_KEY_PARAMETER: props.agentKeyParameter } : {}),
      },
    });
    mirror.grantRead(mcp);
    if (props.agentKeyParameter) {
      mcp.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            this.formatArn({
              service: 'ssm',
              resource: 'parameter',
              resourceName: props.agentKeyParameter.replace(/^\//, ''),
            }),
          ],
        }),
      );
    }

    // The scheduled run signs in with GitHub's short-lived OIDC token: no AWS key is stored in
    // GitHub. The role is usable from one repository and one branch only, and can do exactly two
    // things: keep the working database under state/ and write a published run under san-diego/.
    if (props.ingestRepo) {
      const github = new iam.OidcProviderNative(this, 'GitHubOidc', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      });
      const ingestRole = new iam.Role(this, 'IngestRole', {
        description: 'GitHub Actions ingest workflow: working database and published runs only',
        maxSessionDuration: cdk.Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${props.ingestRepo}:ref:refs/heads/${props.ingestBranch ?? 'main'}`,
          },
        }),
      });
      mirror.grantReadWrite(ingestRole, 'state/*');
      mirror.grantPut(ingestRole, 'san-diego/*');
      new cdk.CfnOutput(this, 'IngestRoleArn', { value: ingestRole.roleArn });
    }

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

    // Public and unauthenticated by design, so it is rate-limited at the door.
    const stage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (stage) stage.defaultRouteSettings = { throttlingBurstLimit: 30, throttlingRateLimit: 15 };

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

    // Explorer UI: static bundle on Amplify, manual-deploy branch (no GitHub token stored).
    const explorer = new amplify.CfnApp(this, 'ExplorerApp', {
      name: `${props.projectName}-explorer`,
      platform: 'WEB',
    });
    const explorerBranch = new amplify.CfnBranch(this, 'ExplorerMain', {
      appId: explorer.attrAppId,
      branchName: 'main',
      stage: 'PRODUCTION',
    });
    new cdk.CfnOutput(this, 'ExplorerAppId', { value: explorer.attrAppId });
    new cdk.CfnOutput(this, 'ExplorerUrl', {
      value: `https://${explorerBranch.branchName}.${explorer.attrDefaultDomain}`,
    });

    new cdk.CfnOutput(this, 'McpUrl', { value: `${httpApi.apiEndpoint}/mcp` });
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'MirrorBucket', { value: mirror.bucketName });
  }
}
