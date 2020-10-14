import * as aws from "@pulumi/aws";

export function createRole(name: string) {
  const role = new aws.iam.Role(`${name}-role`, {
    assumeRolePolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Principal: aws.iam.Principals.LambdaPrincipal,
          Effect: "Allow"
        },
        {
          Action: "sts:AssumeRole",
          Principal: aws.iam.Principals.EdgeLambdaPrincipal,
          Effect: "Allow"
        }
      ]
    }
  });

  new aws.iam.RolePolicyAttachment(`${name}-role-policy-attachment`, {
    role,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole
  });

  return role;
}
