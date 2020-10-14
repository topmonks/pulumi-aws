import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { createRole } from "./edge-role";

async function implementation(event: any, context: aws.lambda.Context) {
  const response = event.Records[0].cf.response;
  const headers = response.headers;

  const addHeader = (headers, key, value) =>
    (headers[key.toLowerCase()] = [{ key, value }]);

  addHeader(headers, "Cache-Control", "public, max-age=31536000, immutable");

  return response;
}

export class AssetsCachingLambda extends pulumi.CustomResource {
  private lambda: aws.lambda.Function;

  get arn() {
    // Not using qualifiedArn here due to some bugs around sometimes returning $LATEST
    return pulumi.interpolate`${this.lambda.arn}:${this.lambda.version}`;
  }

  constructor(name: string, lambda: aws.lambda.Function) {
    super("topmonks-webs:AssetsCachingLambda", name);
    this.lambda = lambda;
  }

  static create(name: string) {
    const role = createRole(name);

    // Some resources _must_ be put in us-east-1, such as Lambda at Edge.
    const awsUsEast1 = new aws.Provider("us-east-1", { region: "us-east-1" });
    const lambda = new aws.lambda.CallbackFunction(
      `${name}-function`,
      {
        publish: true,
        role,
        timeout: 5,
        callback: implementation
      },
      { provider: awsUsEast1 }
    );

    return new AssetsCachingLambda(name, lambda);
  }
}
