import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { createRole } from "./edge-role";
import * as path from "path";

/** @deprecated Use CachePolicy instead */
export class AssetsCachingLambda extends pulumi.ComponentResource {
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
    try {
      const role = createRole(name);

      // Some resources _must_ be put in us-east-1, such as Lambda at Edge.
      const awsUsEast1 = new aws.Provider(`${name}-us-east-1`, {
        region: "us-east-1"
      });
      const lambda = new aws.lambda.Function(
        `${name}-function`,
        {
          publish: true,
          role: role.arn,
          timeout: 5,
          handler: "index.handler",
          runtime: aws.lambda.Runtime.NodeJS14dX,
          code: new pulumi.asset.AssetArchive({
            ".": new pulumi.asset.FileArchive(
              path.resolve(__dirname, "./assets-caching")
            )
          })
        },
        { provider: awsUsEast1 }
      );

      return new AssetsCachingLambda(name, lambda);
    } catch (err) {
      console.error(err);
    }
  }
}
