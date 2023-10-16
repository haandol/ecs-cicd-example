#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/stacks/vpc-stack';
import { CommonServiceStack } from '../lib/stacks/common-service-stack';
import { EchoServiceStack } from '../lib/stacks/services/echo-service';
import { Config } from '../config/loader';

const app = new cdk.App({
  context: {
    ns: Config.app.ns,
    stage: Config.app.stage,
  },
});

const vpcStack = new VpcStack(app, `${Config.app.ns}VpcStack`, {
  vpcId: Config.vpc?.id,
});

const commonServiceStack = new CommonServiceStack(
  app,
  `${Config.app.ns}CommonServiceStack`,
  {
    vpc: vpcStack.vpc,
  }
);
commonServiceStack.addDependency(vpcStack);

// RateCalculationService
const echoService = new EchoServiceStack(
  app,
  `${Config.app.ns}EchoServiceStack`,
  {
    vpc: vpcStack.vpc,
    nlb: commonServiceStack.nlb,
    cluster: commonServiceStack.cluster,
    taskRole: commonServiceStack.taskRole,
    taskExecutionRole: commonServiceStack.taskExecutionRole,
    taskSecurityGroup: commonServiceStack.taskSecurityGroup,
    serviceName: Config.service.echo.name,
    servicePort: Config.service.echo.port,
    ecrRepositoryName: Config.service.echo.ecrRepositoryName,
  }
);
echoService.addDependency(vpcStack);
echoService.addDependency(commonServiceStack);

const tags = cdk.Tags.of(app);
tags.add('namespace', Config.app.ns);
tags.add('stage', Config.app.stage);

app.synth();
