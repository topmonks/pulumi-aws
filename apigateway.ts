import { Output, interpolate } from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { ComponentResource, ResourceOptions } from "@pulumi/pulumi";
import { getCertificate, getHostedZone } from "./website";

export class Api extends ComponentResource {
  readonly gateway: awsx.apigateway.API;

  constructor(name: string, args: ApiArgs, opts?: ResourceOptions) {
    super("topmonks:aws:apigateway:Api", name, {}, opts);

    this.gateway = new awsx.apigateway.API(
      name,
      {
        stageName: "v1",
        routes: createRoutes(name, args.deploymentGroup, args.routes),
        restApiArgs: {
          minimumCompressionSize: 860
        }
      },
      { parent: this }
    );

    const anySchemaModel = new aws.apigateway.Model(
      name,
      {
        name: name.replace(/-/g, "") + "AnySchema",
        contentType: "application/json",
        restApi: this.gateway.restAPI,
        schema: JSON.stringify({
          type: "object",
          title: "Any Schema"
        })
      },
      { parent: this }
    );

    createLambdaMethodExecutions(name, this, anySchemaModel, args.routes);
  }
}

export class CustomDomainDistribution extends ComponentResource {
  private readonly gateway: awsx.apigateway.API;
  readonly domainName: string;
  private readonly basePath?: string;
  readonly apiDistribution: aws.apigateway.DomainName;
  readonly dnsRecord: aws.route53.Record;
  readonly dnsRecordIp6: aws.route53.Record;
  readonly mapping: aws.apigateway.BasePathMapping;

  get url() {
    return this.mapping.domainName.apply(x => `https://${x}/`);
  }

  constructor(
    name: string,
    args: CustomDomainDistributionArgs,
    opts?: ResourceOptions
  ) {
    super("topmonks:aws:apigateway:CustomDomainDistribution", name, {}, opts);

    this.gateway = args.gateway;
    this.domainName = args.domainName;
    this.basePath = args.basePath;

    const apiCertificate = getCertificate(this.domainName);
    this.apiDistribution = new aws.apigateway.DomainName(
      name,
      {
        domainName: this.domainName,
        endpointConfiguration: { types: "EDGE" },
        securityPolicy: "TLS_1_2",
        certificateArn: apiCertificate.apply(x => x.arn)
      },
      { parent: this }
    );
    const hostedZone = getHostedZone(this.domainName);
    this.dnsRecord = new aws.route53.Record(
      `${name}-ipv4`,
      {
        name: this.domainName,
        zoneId: hostedZone.apply(x => x.zoneId),
        type: "A",
        aliases: [
          {
            evaluateTargetHealth: true,
            name: this.apiDistribution.cloudfrontDomainName,
            zoneId: this.apiDistribution.cloudfrontZoneId
          }
        ]
      },
      { parent: this }
    );
    this.dnsRecordIp6 = new aws.route53.Record(
      `${name}-ipv6`,
      {
        name: this.domainName,
        zoneId: hostedZone.apply(x => x.zoneId),
        type: "AAAA",
        aliases: [
          {
            evaluateTargetHealth: true,
            name: this.apiDistribution.cloudfrontDomainName,
            zoneId: this.apiDistribution.cloudfrontZoneId
          }
        ]
      },
      { parent: this }
    );
    this.mapping = new aws.apigateway.BasePathMapping(
      name,
      {
        restApi: this.gateway.restAPI,
        stageName: this.gateway.stage.stageName,
        domainName: this.apiDistribution.domainName,
        basePath: this.basePath
      },
      { parent: this }
    );

    this.registerOutputs({
      apiDistribution: this.apiDistribution,
      mapping: this.mapping,
      dnsRecord: this.dnsRecord,
      dnsRecordIp6: this.dnsRecordIp6
    });
  }
}

export class LambdaMethodExecution extends ComponentResource {
  constructor(
    name: string,
    args: LambdaMethodExecutionArgs,
    opts?: ResourceOptions
  ) {
    super("topmonks:aws:apigateway:LambdaMethodExecution", name, {}, opts);

    const methodResource = getMethodResource(args.gateway, args.path);
    const methodResponse = defineMethodResponse(
      this,
      name,
      args.gateway,
      args.httpMethod,
      args.responseModel,
      methodResource
    );
    defineIntegrationResponse(
      this,
      name,
      args.gateway,
      methodResource,
      methodResponse
    );
  }
}

function createLambdaMethodExecutions(
  name: string,
  parent: Api,
  anySchemaModel: aws.apigateway.Model,
  routes: ApiRoute[]
) {
  routes.map(
    ({ httpMethod, path, responseModel }) =>
      new LambdaMethodExecution(
        `${name}/${httpMethod}${path}`,
        {
          gateway: parent.gateway,
          responseModel: responseModel ?? anySchemaModel,
          httpMethod,
          path
        },
        { parent }
      )
  );
}

function createRoutes(
  name: string,
  deploymentGroup: Output<string> | undefined,
  routes: ApiRoute[]
): awsx.apigateway.Route[] {
  return routes.map(({ httpMethod, path, ...dispatch }) => ({
    method: httpMethod,
    path,
    eventHandler:
      dispatch.type === "named-lambda"
        ? aws.lambda.Function.get(
            `${name}/${httpMethod}${path}`,
            interpolate`${deploymentGroup}-${dispatch.lambdaName}`
          )
        : dispatch.handler
  }));
}

function getMethodResource(
  gateway: awsx.apigateway.API,
  path: string
): Output<aws.apigateway.GetResourceResult> {
  return gateway.restAPI.executionArn.apply(x =>
    gateway.deployment.executionArn.apply(_ =>
      aws.apigateway.getResource({
        path,
        restApiId: <string>x.split(":").pop()
      })
    )
  );
}

function defineMethodResponse(
  parent: LambdaMethodExecution,
  name: string,
  gateway: awsx.apigateway.API,
  httpMethod: string,
  responseModel: aws.apigateway.Model,
  methodResource: Output<aws.apigateway.GetResourceResult>
): aws.apigateway.MethodResponse {
  return new aws.apigateway.MethodResponse(
    name,
    {
      restApi: gateway.restAPI,
      resourceId: methodResource.id,
      httpMethod: httpMethod,
      statusCode: "200",
      responseParameters: {
        "method.response.header.Access-Control-Allow-Headers": true,
        "method.response.header.Access-Control-Allow-Methods": true,
        "method.response.header.Access-Control-Allow-Origin": true
      },
      responseModels: { "application/json": responseModel.name }
    },
    { parent }
  );
}

function defineIntegrationResponse(
  parent: LambdaMethodExecution,
  name: string,
  gateway: awsx.apigateway.API,
  methodResource: Output<aws.apigateway.GetResourceResult>,
  methodResponse: aws.apigateway.MethodResponse
): aws.apigateway.IntegrationResponse {
  return new aws.apigateway.IntegrationResponse(
    name,
    {
      restApi: gateway.restAPI,
      resourceId: methodResource.apply(x => x.id),
      httpMethod: methodResponse.httpMethod,
      statusCode: methodResponse.statusCode,
      responseParameters: {
        "method.response.header.Access-Control-Allow-Headers":
          "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
        "method.response.header.Access-Control-Allow-Methods":
          "'GET,OPTIONS,POST,PUT'",
        "method.response.header.Access-Control-Allow-Origin": "'*'"
      }
    },
    { parent }
  );
}
export interface LambdaMethodExecutionArgs {
  gateway: awsx.apigateway.API;
  httpMethod: awsx.apigateway.Method;
  path: string;
  responseModel: aws.apigateway.Model;
}

type NamedLambdaApiRoute = {
  type: "named-lambda";
  httpMethod: awsx.apigateway.Method;
  path: string;
  lambdaName: string;
  responseModel?: aws.apigateway.Model;
};

type HandlerApiRoute = {
  type: "handler";
  httpMethod: awsx.apigateway.Method;
  path: string;
  handler: aws.lambda.Function;
  responseModel?: aws.apigateway.Model;
};

export type ApiRoute = NamedLambdaApiRoute | HandlerApiRoute;

export interface ApiArgs {
  stageName: string;
  deploymentGroup?: Output<string>;
  routes: ApiRoute[];
}

export interface CustomDomainDistributionArgs {
  gateway: awsx.apigateway.API;
  domainName: string;
  basePath?: string;
}
