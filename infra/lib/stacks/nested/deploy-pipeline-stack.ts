import { Stack, NestedStack, NestedStackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as notifications from 'aws-cdk-lib/aws-codestarnotifications';

interface IProps extends NestedStackProps {
  fargateService: ecs.IBaseService;
  serviceName: string;
  ecrRepositoryName: string;
  codeRepositoryName: string;
  notificationHookUrl?: string;
}

export class DeployPipeline extends NestedStack {
  constructor(scope: Construct, id: string, props: IProps) {
    super(scope, id, props);

    const ns = this.node.tryGetContext('ns') as string;

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${ns}${props.serviceName}`,
      crossAccountKeys: false,
    });
    pipeline.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        resources: ['*'],
      })
    );

    // source stage
    const repository = codecommit.Repository.fromRepositoryName(
      this,
      `CodeRepository`,
      props.codeRepositoryName
    );
    const checkoutStage = pipeline.addStage({ stageName: 'Source' });
    const sourceOutput = codepipeline.Artifact.artifact('source');
    checkoutStage.addAction(
      new cpactions.CodeCommitSourceAction({
        output: sourceOutput,
        branch: 'main',
        actionName: 'checkoutSource',
        repository,
      })
    );

    // build stage
    const project = this.createBuildProject(props);
    const buildOutput = codepipeline.Artifact.artifact('build');
    const buildStage = pipeline.addStage({ stageName: 'Build' });
    buildStage.addAction(
      new cpactions.CodeBuildAction({
        actionName: 'build',
        input: sourceOutput,
        project,
        outputs: [buildOutput],
      })
    );

    // deploy stage
    const deployStage = pipeline.addStage({ stageName: 'Deploy' });
    deployStage.addAction(
      new cpactions.EcsDeployAction({
        actionName: 'deploy',
        imageFile: buildOutput.atPath('imagedefinitions.json'),
        service: props.fargateService,
      })
    );

    const rule = new notifications.NotificationRule(this, 'NotificationRule', {
      source: pipeline,
      events: [
        codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_STARTED,
        codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_SUCCEEDED,
        codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED,
      ],
    });
    const topic = this.newNotificationTopic(ns, props);
    rule.addTarget(topic);
  }

  private newNotificationTopic(ns: string, props: IProps): sns.Topic {
    const topic = new sns.Topic(this, 'PipelineNotificationTopic', {
      displayName: `${ns}PipelineNotification`,
    });

    const fn = new lambdaNodejs.NodejsFunction(this, 'Notification', {
      functionName: `${ns}PipelineNotification`,
      entry: path.resolve(
        __dirname,
        '..',
        '..',
        'functions',
        'notification.ts'
      ),
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        HOOK_URL: props.notificationHookUrl || '',
      },
    });
    topic.addSubscription(new subscriptions.LambdaSubscription(fn));

    return topic;
  }

  private createBuildRole() {
    const role = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:ListSecretVersionIds',
          'secretsmanager:DescribeSecret',
          'secretsmanager:GetSecretValue',
          's3:ListBucket',
          's3:GetObject',
          's3:CopyObject',
          's3:PutObject',
          'kms:Decrypt',
        ],
        resources: ['*'],
        effect: iam.Effect.ALLOW,
      })
    );
    role.addManagedPolicy({
      managedPolicyArn:
        'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser',
    });
    return role;
  }

  private createBuildProject(props: IProps) {
    const role = this.createBuildRole();

    const repositoryUri = `${Stack.of(this).account}.dkr.ecr.${
      Stack.of(this).region
    }.amazonaws.com/${props.ecrRepositoryName}`;
    const buildCommands = [
      'echo Build Dockerfile ... with tag $IMAGE_TAG',
      `docker build -t ${repositoryUri}:latest .`,
      `docker tag ${repositoryUri}:latest ${repositoryUri}:$IMAGE_TAG`,
    ];

    // https://docs.aws.amazon.com/codepipeline/latest/userguide/ecs-cd-pipeline.html
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      environmentVariables: {
        REGION: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: Stack.of(this).region,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              golang: '1.20',
            },
          },
          pre_build: {
            commands: [
              // move to app folder
              'cd app',
              'echo set IMAGE_TAG env',
              'COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)',
              'IMAGE_TAG=${COMMIT_HASH:=latest}',
              'echo Login to ECR ...',
              `aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin "$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com"`,
            ],
          },
          build: { commands: buildCommands },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing the Docker images...',
              `docker push ${repositoryUri}:latest`,
              `docker push ${repositoryUri}:$IMAGE_TAG`,
              'echo Writing imagedefinitions.json ...',
              `printf '[{"name":"${props.serviceName}","imageUri":"${repositoryUri}:%s"}]' $IMAGE_TAG > imagedefinitions.json`,
              `cat imagedefinitions.json`,
            ],
          },
        },
        artifacts: {
          files: ['app/imagedefinitions.json'],
          'discard-paths': 'yes',
        },
      }),
      role,
      environment: {
        privileged: true,
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
    });

    return buildProject;
  }
}
