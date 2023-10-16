# ECS CI/CD Example

CI/CD pipeline triggering by ECR repo changes.

![Architecture](/docs/architecture.png)

# Prerequisites

- git
- awscli
- Nodejs 16.x
- AWS Account and locally configured AWS credential

# Installation

## Setup awscli

```bash
$ aws configure --profile demo
AWS Access Key ID [****************NCHZ]:
AWS Secret Access Key [****************AwoB]:
Default region name [ap-northeast-2]:
Default output format [json]:
```

## Install dependencies

```bash
$ cd infra
$ npm i -g aws-cdk@2.101.0
$ npm i
```

we are using [Taskfile](https://taskfile.dev/) for running script
install taskfile cli

```bash
$ npm i -g @go-task/cli
$ task --list-all
```

## Setup ECR repositories for services

### Create repositories

```bash
$ task create-repo -- --profile demo
```

### Push initial images

```bash
$ task push-echo -- --profile demo
```

## Configuration

open [**infra/config/dev.toml**](/infra/config/dev.toml) and modify if necessary.

> only `user.myip` ip address is allowed to invoke loadbalancer via internet. so change it your local public ip address to test the system.

and copy `config/dev.toml` file to project root as `.toml`

```bash
$ cd infra
$ cp config/dev.toml .toml
```

## Deploy for dev

if you never run bootstrap on the account, bootstrap it.

```bash
$ cdk bootstrap --profile demo
```

deploy infrastructure

```bash
$ cdk deploy "*" --require-approval never --profile demo
```

## Troubleshooting

### Unable to assume the service linked role. Please verify that the ECS service linked role exists.

> there is no ECS service linked-role because you never been trying to create a ECS cluster before. trying to ECS cluster will create the service linked-role.

A: just re-deploy using `cdk deploy` after rollback the stack.
