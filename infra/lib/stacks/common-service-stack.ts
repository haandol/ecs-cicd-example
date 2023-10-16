import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

interface IProps extends StackProps {
  vpc: ec2.IVpc;
}

export class CommonServiceStack extends Stack {
  public readonly cluster: ecs.ICluster;
  public readonly taskRole: iam.IRole;
  public readonly taskExecutionRole: iam.IRole;
  public readonly taskSecurityGroup: ec2.ISecurityGroup;
  public readonly nlb: elbv2.INetworkLoadBalancer;

  constructor(scope: Construct, id: string, props: IProps) {
    super(scope, id, props);

    const ns = this.node.tryGetContext('ns') as string;

    this.taskRole = this.newEcsTaskRole(ns);
    this.taskExecutionRole = this.newEcsTaskExecutionRole(ns);
    this.taskSecurityGroup = this.newEcsTaskSecurityGroup(ns, props);
    this.cluster = this.newEcsCluster(ns, props);
    this.nlb = this.newNetworkLoadbalancer(ns, props, this.taskSecurityGroup);
  }

  newEcsTaskRole(ns: string): iam.IRole {
    const role = new iam.Role(this, `TaskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: `${ns}TaskRole`,
      managedPolicies: [
        // secretsmanager
        { managedPolicyArn: 'arn:aws:iam::aws:policy/SecretsManagerReadWrite' },
        // efs
        {
          managedPolicyArn:
            'arn:aws:iam::aws:policy/AmazonElasticFileSystemClientReadWriteAccess',
        },
      ],
    });
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:PutLogEvents',
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:DescribeLogStreams',
          'logs:DescribeLogGroups',
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
          'xray:GetSamplingStatisticSummaries',
          'ssm:GetParameters',
        ],
        resources: ['*'],
        effect: iam.Effect.ALLOW,
      })
    );
    return role.withoutPolicyUpdates();
  }

  newEcsTaskExecutionRole(ns: string): iam.IRole {
    return new iam.Role(this, `TaskExecutionRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: `${ns}TaskExecutionRole`,
      managedPolicies: [
        {
          managedPolicyArn:
            'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
        },
      ],
    }).withoutPolicyUpdates();
  }

  newEcsTaskSecurityGroup(ns: string, props: IProps): ec2.ISecurityGroup {
    const securityGroup = new ec2.SecurityGroup(this, `TaskSecurityGroup`, {
      securityGroupName: `${ns}TaskSecurityGroup`,
      vpc: props.vpc,
    });
    securityGroup.connections.allowInternally(
      ec2.Port.allTcp(),
      'Allow Internal'
    );
    securityGroup.connections.allowFrom(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.allTcp(),
      'Allow VPC'
    );
    return securityGroup;
  }

  newEcsCluster(ns: string, props: IProps): ecs.ICluster {
    return new ecs.Cluster(this, `Cluster`, {
      clusterName: ns.toLowerCase(),
      vpc: props.vpc,
      defaultCloudMapNamespace: {
        name: ns.toLowerCase(),
      },
      enableFargateCapacityProviders: true,
      containerInsights: true,
    });
  }

  newNetworkLoadbalancer(
    ns: string,
    props: IProps,
    securityGroup: ec2.ISecurityGroup
  ): elbv2.NetworkLoadBalancer {
    const nlb = new elbv2.NetworkLoadBalancer(this, `ServiceNLB`, {
      loadBalancerName: ns.toLowerCase(),
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      internetFacing: true,
    });
    const cfnlb = nlb.node.defaultChild as elbv2.CfnLoadBalancer;
    cfnlb.addPropertyOverride('SecurityGroups', [
      securityGroup.securityGroupId,
    ]);

    new CfnOutput(this, 'NLBDnsName', {
      value: nlb.loadBalancerDnsName,
    });
    return nlb;
  }
}
