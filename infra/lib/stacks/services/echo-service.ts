import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { DeployPipeline } from '../nested/deploy-pipeline-stack';

interface IProps extends StackProps {
  readonly nlb: elbv2.INetworkLoadBalancer;
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly taskRole: iam.IRole;
  readonly taskExecutionRole: iam.IRole;
  readonly taskSecurityGroup: ec2.ISecurityGroup;
  // service
  readonly serviceName: string;
  readonly servicePort: number;
  readonly ecrRepositoryName: string;
  readonly codeRepositoryName: string;
  readonly notificationHookUrl?: string;
}

export class EchoServiceStack extends Stack {
  constructor(scope: Construct, id: string, props: IProps) {
    super(scope, id, props);

    const ns = this.node.tryGetContext('ns') as string;
    const taskDefinition = this.newTaskDefinition(ns, props);
    const fargateService = this.newFargateService(ns, taskDefinition, props);

    this.registerServiceToLoadBalancer(fargateService, props);

    new DeployPipeline(this, 'DeployPipeline', {
      fargateService,
      serviceName: props.serviceName,
      ecrRepositoryName: props.ecrRepositoryName,
      codeRepositoryName: props.codeRepositoryName,
      notificationHookUrl: props.notificationHookUrl,
    });
  }

  private newTaskDefinition(ns: string, props: IProps): ecs.TaskDefinition {
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      `TaskDefinition`,
      {
        family: `${ns}${props.serviceName}`,
        taskRole: props.taskRole,
        executionRole: props.taskExecutionRole,
        runtimePlatform: {
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
        },
        cpu: 256,
        memoryLimitMiB: 512,
      }
    );

    // service container
    const serviceRepository = ecr.Repository.fromRepositoryName(
      this,
      `ServiceRepository`,
      props.ecrRepositoryName
    );
    const logging = new ecs.AwsLogDriver({
      streamPrefix: ns.toLowerCase(),
    });
    taskDefinition.addContainer(`Container`, {
      containerName: props.serviceName,
      image: ecs.ContainerImage.fromEcrRepository(serviceRepository),
      logging,
      healthCheck: {
        command: [
          'CMD-SHELL',
          `curl -f http://localhost:${props.servicePort}/ || exit 1`,
        ],
      },
      portMappings: [
        { containerPort: props.servicePort, protocol: ecs.Protocol.TCP },
      ],
    });
    // otel container
    taskDefinition.addContainer(`OTelContainer`, {
      containerName: 'aws-otel-collector',
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/aws-observability/aws-otel-collector'
      ),
      command: ['--config=/etc/ecs/ecs-default-config.yaml'],
      portMappings: [
        { containerPort: 4317, protocol: ecs.Protocol.TCP },
        { containerPort: 4318, protocol: ecs.Protocol.TCP },
        { containerPort: 2000, protocol: ecs.Protocol.UDP },
      ],
    });

    return taskDefinition;
  }

  private newFargateService(
    ns: string,
    taskDefinition: ecs.TaskDefinition,
    props: IProps
  ) {
    const service = new ecs.FargateService(this, 'FargateService', {
      serviceName: `${ns}${props.serviceName}`,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      cluster: props.cluster,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        availabilityZones: [props.vpc.publicSubnets[0].availabilityZone],
      },
      circuitBreaker: { rollback: true },
      desiredCount: 1,
      taskDefinition,
      securityGroups: [props.taskSecurityGroup],
    });

    const scalableTarget = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 2,
    });
    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
    });
    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 70,
    });

    return service;
  }

  private registerServiceToLoadBalancer(
    fargateService: ecs.FargateService,
    props: IProps
  ) {
    const targetGroup = new elbv2.NetworkTargetGroup(this, 'TargetGroup', {
      port: props.servicePort,
      vpc: props.vpc,
      targets: [fargateService],
      healthCheck: {
        enabled: true,
      },
    });
    new elbv2.NetworkListener(this, 'Listener', {
      loadBalancer: props.nlb,
      port: props.servicePort,
      defaultTargetGroups: [targetGroup],
    });
  }
}
