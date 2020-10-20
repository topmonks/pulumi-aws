import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { ComponentResource, ResourceOptions } from "@pulumi/pulumi";
import { getCertificate, getHostedZone } from "./website";

export class CustomDomainDistribution extends ComponentResource {
  private readonly gateway: awsx.apigateway.API;
  private readonly domainName: string;
  private readonly basePath?: string;
  private readonly apiDistribution: aws.apigateway.DomainName;
  private readonly dnsRecord: aws.route53.Record;
  private readonly dnsRecordIp6: aws.route53.Record;
  private readonly mapping: aws.apigateway.BasePathMapping;

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
    this.apiDistribution = new aws.apigateway.DomainName(name, {
      domainName: this.domainName,
      endpointConfiguration: { types: "EDGE" },
      securityPolicy: "TLS_1_2",
      certificateArn: apiCertificate.apply(x => x.arn)
    });
    const hostedZone = getHostedZone(this.domainName);
    this.dnsRecord = new aws.route53.Record(name, {
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
    });
    this.dnsRecordIp6 = new aws.route53.Record(name, {
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
    });
    this.mapping = new aws.apigateway.BasePathMapping(name, {
      restApi: this.gateway.restAPI,
      stageName: this.gateway.stage.stageName,
      domainName: this.apiDistribution.domainName,
      basePath: this.basePath
    });

    this.registerOutputs({
      apiDistribution: this.apiDistribution,
      mapping: this.mapping,
      dnsRecord: this.dnsRecord
    });
  }
}

export interface CustomDomainDistributionArgs {
  gateway: awsx.apigateway.API;
  domainName: string;
  basePath?: string;
}
