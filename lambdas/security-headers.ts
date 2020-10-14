import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { createRole } from "./edge-role";

async function implementation(event: any, context: aws.lambda.Context) {
  const response = event.Records[0].cf.response;
  const headers = response.headers;

  const addHeader = (headers, key, value) =>
    (headers[key.toLowerCase()] = [{ key, value }]);

  addHeader(headers, "Strict-Transport-Security", "max-age=31536000; preload");
  addHeader(headers, "X-Content-Type-Options", "nosniff");
  addHeader(headers, "X-Frame-Options", "DENY");
  addHeader(headers, "X-XSS-Protection", "1; mode=block");
  addHeader(
    headers,
    "Referrer-Policy",
    "no-referrer, strict-origin-when-cross-origin"
  );

  // Pinned Keys are the Amazon intermediate: "s:/C=US/O=Amazon/OU=Server CA 1B/CN=Amazon"
  //   and LetsEncrypt "Let’s Encrypt Authority X1 (IdenTrust cross-signed)"
  // headers["Public-Key-Pins".toLowerCase()] = [
  //   {
  //     key: "Public-Key-Pins",
  //     value:
  //       'pin-sha256="JSMzqOOrtyOT1kmau6zKhgT676hGgczD5VMdRMyJZFA="; pin-sha256="YLh1dUR9y6Kja30RrAn7JKnbQG/uEtLMkBgFF2Fuihg="; max-age=1296001; includeSubDomains'
  //   }
  // ];

  return response;
}

export class SecurityHeadersLambda extends pulumi.CustomResource {
  private lambda: aws.lambda.Function;

  get arn() {
    // Not using qualifiedArn here due to some bugs around sometimes returning $LATEST
    return pulumi.interpolate`${this.lambda.arn}:${this.lambda.version}`;
  }

  constructor(name: string, lambda: aws.lambda.Function) {
    super("topmonks-webs:SecurityHeadersLambda", name);
    this.lambda = lambda;
  }

  static create(name: string) {
    const role = createRole(name);

    // Some resources _must_ be put in us-east-1, such as Lambda at Edge.
    const awsUsEast1 = new aws.Provider(`${name}-us-east-1`, {
      region: "us-east-1"
    });
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

    return new SecurityHeadersLambda(name, lambda);
  }
}
