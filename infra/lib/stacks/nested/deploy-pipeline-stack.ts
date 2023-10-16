import { Stack, NestedStack, NestedStackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';

interface IProps extends NestedStackProps {
  fargateService: ecs.IBaseService;
  serviceName: string;
  ecrRepositoryName: string;
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
    const repository = ecr.Repository.fromRepositoryName(
      this,
      `EcrRepository`,
      props.ecrRepositoryName
    );
    const checkoutStage = pipeline.addStage({ stageName: 'Source' });
    const sourceOutput = codepipeline.Artifact.artifact('source');
    checkoutStage.addAction(
      new cpactions.EcrSourceAction({
        output: sourceOutput,
        imageTag: 'latest',
        actionName: 'ecrSource',
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
    role.addManagedPolicy({
      managedPolicyArn:
        'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
    });
    return role;
  }

  private createBuildProject(props: IProps) {
    const role = this.createBuildRole();

    const repositoryUri = `${Stack.of(this).account}.dkr.ecr.${
      Stack.of(this).region
    }.amazonaws.com/${props.ecrRepositoryName}`;
    const buildCommands = [
      'echo "pull latest image"',
      `docker pull ${repositoryUri}:latest`,
      'echo "tag latest to $IMAGE_TAG"',
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
              golang: '1.18',
            },
          },
          pre_build: {
            commands: [
              'echo set IMAGE_TAG env',
              'IMAGE_TAG=$CODEBUILD_BUILD_NUMBER',
              'echo Login to ECR ...',
              `aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin "$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com"`,
            ],
          },
          build: { commands: buildCommands },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing the Docker images...',
              `docker push ${repositoryUri}:$IMAGE_TAG`,
              'echo Writing imagedefinitions.json ...',
              `printf '[{"name":"${props.serviceName}","imageUri":"${repositoryUri}:%s"}]' $IMAGE_TAG > imagedefinitions.json`,
              `cat imagedefinitions.json`,
            ],
          },
        },
        artifacts: {
          files: ['imagedefinitions.json'],
          'discard-paths': 'yes',
        },
      }),
      role,
      environment: {
        privileged: true,
        buildImage: codebuild.LinuxBuildImage.STANDARD_6_0,
      },
    });

    return buildProject;
  }
}
