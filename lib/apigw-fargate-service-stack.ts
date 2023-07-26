import * as apigwv2 from '@aws-cdk/aws-apigatewayv2-alpha';
import * as apigwv2integ from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import * as firehose from '@aws-cdk/aws-kinesisfirehose-alpha';
import * as destinations from '@aws-cdk/aws-kinesisfirehose-destinations-alpha';
import * as cdk from 'aws-cdk-lib';
import {
  aws_servicediscovery as cloudmap,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deployment,
} from 'aws-cdk-lib';
import { SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as path from 'path';

export class ApiGatewayFargateServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for Fluentbit config files
    const configBucket = new s3.Bucket(this, 'FluentbitConfigBucket', {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new s3deployment.BucketDeployment(this, 'BucketDeployment', {
      destinationBucket: configBucket,
      sources: [s3deployment.Source.asset(path.resolve('fluentbit-config'))],
      retainOnDelete: false,
    });

    // S3 bucket for logs
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Firehose
    const deliveryStream = new firehose.DeliveryStream(this, 'DeliveryStream', {
      destinations: [
        new destinations.S3Bucket(logBucket, {
          dataOutputPrefix:
            'firehose/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/rand=!{firehose:random-string}',
          errorOutputPrefix:
            'firehoseFailures/!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/!{firehose:error-output-type}',
          compression: destinations.Compression.GZIP,
        }),
      ],
    });

    // Log Group for error logs
    const logGroup = new logs.LogGroup(this, 'ErrorLogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 1,
    });
    const serviceName = 'www';
    const serviceNameSpace = 'example.com';
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: vpc,
      defaultCloudMapNamespace: { name: serviceNameSpace },
    });
    const taskdef = new ecs.FargateTaskDefinition(this, 'ExampleTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    taskdef.addContainer('nginx', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.firelens({}),
    });
    taskdef.addFirelensLogRouter('FireLensLogRouter', {
      containerName: 'fluentbit',
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-for-fluent-bit:init-latest'),
      firelensConfig: {
        type: ecs.FirelensLogRouterType.FLUENTBIT,
      },
      environment: {
        FIREHOSE_DELIVERY_STREAM_NAME: deliveryStream.deliveryStreamName,
        LOG_GROUP_NAME: logGroup.logGroupName,
        aws_fluent_bit_init_s3_1: `${configBucket.bucketArn}/extra.conf`,
        aws_fluent_bit_init_file_1: '/fluent-bit/parsers/parsers.conf',
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: new logs.LogGroup(this, 'FluentbitLogGroup'),
        streamPrefix: 'fluentbit',
      }),
    });
    configBucket.grantRead(taskdef.taskRole);
    deliveryStream.grantPutRecords(taskdef.taskRole);
    logGroup.grantWrite(taskdef.taskRole);

    const service = new ecs.FargateService(this, 'Service', {
      cluster: cluster,
      taskDefinition: taskdef,
      cloudMapOptions: {
        name: serviceName,
        dnsRecordType: cloudmap.DnsRecordType.SRV,
      },
      desiredCount: 1,
      enableExecuteCommand: true,
    });

    // API Gateway HTTP API
    const httpApiSg = new SecurityGroup(this, 'HttpApiVpcLinkSg', {
      vpc: vpc,
      allowAllOutbound: true,
    });
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      defaultIntegration: new apigwv2integ.HttpServiceDiscoveryIntegration(
        'DefaultIntegration',
        service.cloudMapService!,
        {
          method: apigwv2.HttpMethod.ANY,
          vpcLink: new apigwv2.VpcLink(this, 'VpcLink', { vpc: vpc, securityGroups: [httpApiSg] }),
        },
      ),
    });
    service.connections.allowFrom(httpApiSg, ec2.Port.tcp(80));

    new cdk.CfnOutput(this, 'HttpApiEndpoint', {
      value: cdk.Token.asString(httpApi.apiEndpoint),
    });
    new cdk.CfnOutput(this, 'ECSClusterName', {
      value: cdk.Token.asString(cluster.clusterName),
    });
    new cdk.CfnOutput(this, 'S3Bucket', {
      value: cdk.Token.asString(logBucket.bucketName),
    });
    new cdk.CfnOutput(this, 'LogGroupName', {
      value: cdk.Token.asString(logGroup.logGroupName),
    });
  }
}
