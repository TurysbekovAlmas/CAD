# KBTU Cloud Application Development — SIS 3 (Infrastructure as Code)

Reproducible event-driven and containerized order processing system defined as Infrastructure as Code using **AWS CloudFormation / SAM** (`template.yaml`).

## Architecture Overview

- **Ingress & Compute:** Application Load Balancer (`AWS::ElasticLoadBalancingV2::LoadBalancer`) routing HTTP traffic to an **ECS Fargate** service (`orders-api`) running in public subnets with `AssignPublicIp: ENABLED` (avoiding NAT Gateway costs).
- **Container Registry:** Amazon ECR repository (`sis3-orders-api`) configured with **IMMUTABLE** image tags, scan-on-push, and a lifecycle policy expiring untagged images after 1 day and keeping the latest 10 images.
- **Security (Least Privilege):** Two distinct IAM roles for Fargate — `EcsTaskExecutionRole` (pulling ECR images and writing CloudWatch logs) and `EcsTaskRole` (scoped strictly to `dynamodb:PutItem`, `dynamodb:GetItem`, and `events:PutEvents`). Task Security Group accepts traffic on port `8080` exclusively from the ALB Security Group.
- **Messaging & Asynchronous Processing:**
  - `orders-api` writes orders idempotently to **DynamoDB** (`ConditionExpression`) and emits `OrderPlaced` domain events to **Amazon EventBridge** (scoped per stack via `kbtu.shop.orders.${AWS::StackName}`).
  - EventBridge rule routes matching events to an **Amazon SQS** queue (`OrdersQueue`) backed by a **Dead-Letter Queue** (`OrdersDLQ`, `maxReceiveCount: 5`).
  - **AWS Lambda** (`OrdersConsumerFunction`) processes batches idempotently with partial batch failure reporting (`ReportBatchItemFailures`).
- **Observability:** Dedicated CloudWatch Log Groups for both ECS and Lambda configured with `RetentionInDays: 7`.

---

## Prerequisites

- AWS CLI v2 configured with valid credentials (`us-east-1`)
- Docker Desktop (for building and pushing the container image to ECR)

---

## Step 1: One-Time Account Setup (ECR & Artifact Bucket)

Create the immutable ECR repository, apply the lifecycle policy, push the container image (`v1.0.0`), and create an S3 bucket for CloudFormation packaging:

```powershell
$ACCOUNT_ID = "857190082605"
$REGION = "us-east-1"
$REPO = "sis3-orders-api"
$ARTIFACT_BUCKET = "cad-sis3-artifacts-$ACCOUNT_ID"

# 1. Create ECR repository with IMMUTABLE tags
aws ecr create-repository `
  --repository-name $REPO `
  --region $REGION `
  --image-tag-mutability IMMUTABLE `
  --image-scanning-configuration scanOnPush=true

# 2. Apply ECR Lifecycle Policy
@'
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Expire untagged",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 1
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Keep last 10",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": { "type": "expire" }
    }
  ]
}
'@ | Out-File -Encoding ascii policy.json

aws ecr put-lifecycle-policy --repository-name $REPO --region$REGION --lifecycle-policy-text file://policy.json
Remove-Item policy.json

# 3. Build and push container image
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
docker buildx build --platform linux/amd64 -t "$ACCOUNT_ID.dkr.ecr.$[REGION.amazonaws.com/$](https://REGION.amazonaws.com/$){REPO}:v1.0.0" --push ./app

# 4. Create S3 bucket for packaging Lambda artifacts
aws s3 mb "s3://$ARTIFACT_BUCKET" --region $REGION
Step 2: Package and Deploy the Stack (One-Command Deploy)
Retrieve the default VPC and two subnets in us-east-1, package the SAM/CloudFormation template, and deploy:

PowerShell
$VPC_ID = aws ec2 describe-vpcs --region us-east-1 --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text
$SUBNETS = aws ec2 describe-subnets --region us-east-1 --filters "Name=vpc-id,Values=$VPC_ID" --query "Subnets[0:2].SubnetId" --output text
$SUBNET_LIST = ($SUBNETS -split "\s+") -join ","

# Package Lambda code and transform template
aws cloudformation package `
  --template-file template.yaml `
  --s3-bucket cad-sis3-artifacts-857190082605 `
  --output-template-file packaged.yaml

# Deploy primary stack
aws cloudformation deploy `
  --template-file packaged.yaml `
  --stack-name sis3-main `
  --region us-east-1 `
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides `
    "Env=dev" `
    "ImageUri=[857190082605.dkr.ecr.us-east-1.amazonaws.com/sis3-orders-api:v1.0.0](https://857190082605.dkr.ecr.us-east-1.amazonaws.com/sis3-orders-api:v1.0.0)" `
    "VpcId=$VPC_ID" `
    "SubnetIds=$SUBNET_LIST"
View stack outputs (ServiceUrl, OrdersQueueUrl, OrdersDLQUrl, OrdersTableName):

PowerShell
aws cloudformation describe-stacks --stack-name sis3-main --region us-east-1 --query "Stacks[0].Outputs" --output table
Step 3: Reproducibility Test (Second Independent Stack)
Because all physical resource names and EventBridge sources are dynamically scoped to ${AWS::StackName} (with no hardcoded names), a completely isolated second copy can be deployed in the same account and region without collisions:

PowerShell
aws cloudformation deploy `
  --template-file packaged.yaml `
  --stack-name sis3-copy `
  --region us-east-1 `
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides `
    "Env=dev" `
    "ImageUri=[857190082605.dkr.ecr.us-east-1.amazonaws.com/sis3-orders-api:v1.0.0](https://857190082605.dkr.ecr.us-east-1.amazonaws.com/sis3-orders-api:v1.0.0)" `
    "VpcId=$VPC_ID" `
    "SubnetIds=$SUBNET_LIST"
Step 4: End-to-End Verification
PowerShell
$ALB_URL = aws cloudformation describe-stacks --stack-name sis3-main --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='ServiceUrl'].OutputValue" --output text
$TABLE = aws cloudformation describe-stacks --stack-name sis3-main --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='OrdersTableName'].OutputValue" --output text

# 1. Health check
Invoke-RestMethod -Uri "$ALB_URL/health" -Method Get

# 2. Create order (201 Created -> EventBridge -> SQS -> Lambda -> ASYNC_PROCESSED)
Invoke-RestMethod -Uri "$ALB_URL/orders" -Method Post -ContentType "application/json" -Body '{"order_id":"ord-101","customer_id":"c1","total":199}'

# 3. Verify API idempotency (returns HTTP 409 Conflict on duplicate order_id)
Invoke-RestMethod -Uri "$ALB_URL/orders" -Method Post -ContentType "application/json" -Body '{"order_id":"ord-101","customer_id":"c1","total":199}'

# 4. Verify async DynamoDB status update
Start-Sleep -Seconds 5
aws dynamodb scan --table-name $TABLE --region us-east-1 --output table

# 5. Simulate consumer failure to test DLQ routing (routes to OrdersDLQ after 5 attempts)
Invoke-RestMethod -Uri "$ALB_URL/orders" -Method Post -ContentType "application/json" -Body '{"order_id":"ord-fail-1","customer_id":"c1","total":50,"force_fail":true}'
Step 5: Teardown / Cleanup
Delete stacks cleanly with a single command per stack:

PowerShell
aws cloudformation delete-stack --stack-name sis3-copy --region us-east-1
aws cloudformation delete-stack --stack-name sis3-main --region us-east-1