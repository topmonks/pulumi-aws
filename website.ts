import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as inputs from "@pulumi/aws/types/input";
import { Bucket } from "@pulumi/aws/s3";

const websiteConfig = new pulumi.Config("topmonks_website");
const assetsPaths: string[] = JSON.parse(
  websiteConfig.get("assets_paths") ?? "[]"
);
const assetsCachingLambdaArn = websiteConfig.get("assets_caching_lambda_arn");
const securityHeadersLambdaArn = websiteConfig.get(
  "security_headers_lambda_arn"
);

/**
 * Creates S3 bucket with static website hosting enabled
 * @param parent {pulumi.ComponentResource} parent component
 * @param domain {string} website domain name
 * @param settings {aws.s3.BucketArgs}
 * @returns {aws.s3.Bucket}
 */
function createBucket(
  parent: pulumi.ComponentResource,
  domain: string,
  settings: aws.s3.BucketArgs
) {
  const website = settings.website || {
    indexDocument: "index.html",
    errorDocument: "404.html"
  };
  return new aws.s3.Bucket(
    `${domain}/bucket`,
    {
      bucket: domain,
      acl: "public-read",
      website,
      corsRules: [
        {
          allowedHeaders: ["*"],
          allowedMethods: ["GET", "HEAD", "OPTIONS"],
          allowedOrigins: ["*"]
        }
      ],
      forceDestroy: true
    },
    { parent }
  );
}

/**
 * Creates Public read bucket policy
 * @param parent {pulumi.ComponentResource} parent component
 * @param domain {string} website domain name
 * @param bucket {aws.s3.Bucket}
 * @returns {aws.s3.BucketPolicy}
 */
function createBucketPolicy(
  parent: pulumi.ComponentResource,
  domain: string,
  bucket: aws.s3.Bucket
) {
  return new aws.s3.BucketPolicy(
    `${domain}/bucket-policy`,
    {
      bucket: bucket.bucket,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "1",
            Effect: "Allow",
            Principal: {
              AWS: "*"
            },
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${domain}/*`
          }
        ]
      })
    },
    { parent }
  );
}

function createLambdaAssociation(
  pathPattern: string,
  lambdaAssociation: {
    lambdaArn: string | pulumi.Output<string>;
    eventType: string;
  },
  contentBucket: Bucket,
  securityHeadersLambdaArn: any
) {
  const cacheBehavior = {
    pathPattern: pathPattern,
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    cachedMethods: ["GET", "HEAD", "OPTIONS"],
    minTtl: 0,
    defaultTtl: 86400,
    maxTtl: 31536000,
    // enable gzip
    compress: true,
    targetOriginId: contentBucket.arn,
    viewerProtocolPolicy: "redirect-to-https",
    forwardedValues: {
      cookies: { forward: "none" },
      headers: [
        "Origin",
        "Access-Control-Request-Headers",
        "Access-Control-Request-Method"
      ],
      queryString: true
    },
    lambdaFunctionAssociations: [lambdaAssociation]
  };
  if (securityHeadersLambdaArn) {
    cacheBehavior.lambdaFunctionAssociations.push({
      eventType: "viewer-response",
      lambdaArn: securityHeadersLambdaArn
    });
  }
  return cacheBehavior;
}

/**
 * Creates CloudFront distribution on top of S3 website
 * @param parent {pulumi.ComponentResource} parent component
 * @param domain {string} website domain name
 * @param contentBucket {aws.s3.Bucket}
 * @param isPwa {boolean}
 * @param assetsPaths {string[]}
 * @param assetsCachingLambdaArn {string}
 * @param securityHeadersLambdaArn {string}
 * @param edgeLambdas {EdgeLambdaAssociation[]}
 * @returns {aws.cloudfront.Distribution}
 */
function createCloudFront(
  parent: pulumi.ComponentResource,
  domain: string,
  contentBucket: aws.s3.Bucket,
  isPwa: boolean | undefined,
  assetsPaths?: string[],
  assetsCachingLambdaArn?: string | pulumi.Output<string>,
  securityHeadersLambdaArn?: string | pulumi.Output<string>,
  edgeLambdas?: EdgeLambdaAssociation[]
) {
  const acmCertificate = getCertificate(domain);
  const customErrorResponses: pulumi.Input<inputs.cloudfront.DistributionCustomErrorResponse>[] = [];
  if (isPwa) {
    customErrorResponses.push({
      errorCode: 404,
      responseCode: 200,
      responsePagePath: "/index.html"
    });
  }

  const assetsCacheBoost = pathPattern => ({
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    cachedMethods: ["GET", "HEAD", "OPTIONS"],
    compress: true,
    defaultTtl: 31536000,
    forwardedValues: {
      cookies: {
        forward: "none"
      },
      headers: ["Origin"],
      queryString: false
    },
    maxTtl: 31536000,
    minTtl: 31536000,
    pathPattern,
    targetOriginId: contentBucket.arn,
    viewerProtocolPolicy: "redirect-to-https",
    lambdaFunctionAssociations: assetsCachingLambdaArn
      ? [
          // add lambda edge with cache headers for immutable assets
          {
            eventType: "viewer-response",
            lambdaArn: assetsCachingLambdaArn
          }
        ]
      : undefined
  });
  const lambdaAssociation = ({ pathPattern, lambdaAssociation }) =>
    createLambdaAssociation(
      pathPattern,
      lambdaAssociation,
      contentBucket,
      securityHeadersLambdaArn
    );
  const assetsCacheBehaviors = assetsPaths?.map(assetsCacheBoost);
  const lambdaAssociationBehavior = edgeLambdas?.map(lambdaAssociation);
  const orderedCacheBehaviors =
    assetsCacheBehaviors && lambdaAssociationBehavior
      ? assetsCacheBehaviors.concat(lambdaAssociationBehavior)
      : assetsCacheBehaviors ?? lambdaAssociationBehavior;

  return new aws.cloudfront.Distribution(
    `${domain}/cdn-distribution`,
    {
      enabled: true,
      aliases: [domain],
      origins: [
        {
          originId: contentBucket.arn,
          domainName: contentBucket.websiteEndpoint,
          customOriginConfig: {
            // Amazon S3 doesn't support HTTPS connections when using an S3 bucket configured as a website endpoint.
            // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesOriginProtocolPolicy
            originProtocolPolicy: "http-only",
            httpPort: 80,
            httpsPort: 443,
            originSslProtocols: ["TLSv1.2"]
          }
        }
      ],
      customErrorResponses,
      defaultRootObject: "index.html",
      defaultCacheBehavior: {
        targetOriginId: contentBucket.arn,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
          cookies: { forward: "none" },
          headers: [
            "Origin",
            "Access-Control-Request-Headers",
            "Access-Control-Request-Method"
          ],
          queryString: false
        },
        minTtl: 0,
        defaultTtl: 86400,
        maxTtl: 31536000,
        // enable gzip
        compress: true,
        lambdaFunctionAssociations: securityHeadersLambdaArn
          ? [
              // add lambda edge with security headers for A+ SSL Grade
              {
                eventType: "viewer-response",
                lambdaArn: securityHeadersLambdaArn
              }
            ]
          : undefined
      },
      orderedCacheBehaviors,
      priceClass: "PriceClass_100",
      restrictions: {
        geoRestriction: {
          restrictionType: "none"
        }
      },
      viewerCertificate: {
        acmCertificateArn: acmCertificate.apply(x => x.arn),
        sslSupportMethod: "sni-only",
        minimumProtocolVersion: "TLSv1.2_2019"
      },
      isIpv6Enabled: true
    },
    {
      parent,
      dependsOn: [contentBucket]
    }
  );
}

/**
 * Creates a new Route53 DNS record pointing the domain or the CloudFront distribution.
 * For CloudFront distribution ALIAS record is created. Otherwise CNAME.
 * This allowes to have naked domain websites.
 * @param parent {pulumi.ComponentResource} parent component
 * @param domain {string} website domain name
 * @param cname {pulumi.Output<string>} aliased domain name
 * @returns {aws.route53.Record[]}
 */
function createAliasRecords(
  parent: Website,
  domain: string,
  cname: pulumi.Output<string>
): aws.route53.Record[] {
  const hostedZone = getHostedZone(domain);
  const cdn = parent.cdn;
  if (!cdn) {
    const args: aws.route53.RecordArgs = {
      name: domain,
      zoneId: hostedZone.apply(x => x.zoneId),
      ttl: 300,
      type: "CNAME",
      records: [cname]
    };
    return [new aws.route53.Record(`${domain}/dns-record`, args, { parent })];
  }

  const args = (type: string) => ({
    name: domain,
    zoneId: hostedZone.apply(x => x.zoneId),
    type,
    aliases: [
      {
        evaluateTargetHealth: true,
        name: cdn.domainName,
        zoneId: cdn.hostedZoneId
      }
    ]
  });
  return [
    new aws.route53.Record(`${domain}/dns-record`, args("A"), { parent }),
    new aws.route53.Record(`${domain}/dns-record-ipv6`, args("AAAA"), {
      parent
    })
  ];
}

export function createTxtRecord(name: string, domain: string, value: string) {
  const hostedZone = getHostedZone(domain);
  return new aws.route53.Record(`${domain}/txt-record-${name}`, {
    name: hostedZone.apply(x => x.name),
    type: "TXT",
    zoneId: hostedZone.apply(x => x.zoneId),
    records: [value],
    ttl: 3600
  });
}

export function createGoogleMxRecords(domain: string) {
  const hostedZone = getHostedZone(domain);
  return new aws.route53.Record(`${domain}/google-mx-records`, {
    name: hostedZone.apply(x => x.name),
    type: "MX",
    zoneId: hostedZone.apply(x => x.zoneId),
    records: [
      "1 ASPMX.L.GOOGLE.COM.",
      "5 ALT1.ASPMX.L.GOOGLE.COM.",
      "5 ALT2.ASPMX.L.GOOGLE.COM.",
      "10 ALT3.ASPMX.L.GOOGLE.COM.",
      "10 ALT4.ASPMX.L.GOOGLE.COM."
    ],
    ttl: 3600
  });
}

export function getHostedZone(domain: string) {
  const hostedZone = aws.route53.getZone({
    name: getRootDomain(domain)
  });
  return pulumi.output(hostedZone);
}

/**
 * Creates Widlcard certificate for top domain.
 * This creates certificate for root domain with wildcard for all subdomains.
 * You will need to have just one instance per all your stacks.
 * @param domain {string} website domain name
 * @returns {pulumi.Output<pulumi.Unwrap<aws.acm.GetCertificateResult>>}
 */
export function createCertificate(domain: string) {
  const parentDomain = getParentDomain(domain);
  const usEast1 = new aws.Provider(`${domain}/provider/us-east-1`, {
    profile: aws.config.profile,
    region: aws.USEast1Region
  });

  const certificate = new aws.acm.Certificate(
    `${parentDomain}-certificate`,
    {
      domainName: `*.${parentDomain}`,
      subjectAlternativeNames: [parentDomain],
      validationMethod: "DNS"
    },
    { provider: usEast1 }
  );
  const hostedZoneId = aws.route53
    .getZone({ name: getRootDomain(domain) }, { async: true })
    .then(zone => zone.zoneId);

  /**
   * Create a Certification Authority Authorization (CAA) DNS record to specify that AWS Certificate Manager (ACM)
   * is allowed to issue a certificate for your domain or subdomain.
   * See https://docs.aws.amazon.com/acm/latest/userguide/setup-caa.html for more info.
   */
  const caaRecord = new aws.route53.Record(`${parentDomain}-caaRecord`, {
    name: parentDomain,
    zoneId: hostedZoneId,
    type: "CAA",
    records: [
      `0 issue "letsencrypt.org"`,
      `0 issue "pki.goog"`,
      `0 issue "amazon.com"`,
      `0 issue "amazontrust.com"`,
      `0 issue "awstrust.com"`,
      `0 issue "amazonaws.com"`,
      `0 issuewild "amazon.com"`,
      `0 issuewild "amazontrust.com"`,
      `0 issuewild "awstrust.com"`,
      `0 issuewild "amazonaws.com"`,
      `0 iodef "mailto:admin@topmonks.com"`
    ],
    ttl: 3600
  });

  /**
   *  Create a DNS record to prove that we _own_ the domain we're requesting a certificate for.
   *  See https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-validate-dns.html for more info.
   */
  const certificateValidationDomain = new aws.route53.Record(
    `${parentDomain}-validationRecord`,
    {
      name: certificate.domainValidationOptions[0].resourceRecordName,
      zoneId: hostedZoneId,
      type: certificate.domainValidationOptions[0].resourceRecordType,
      records: [certificate.domainValidationOptions[0].resourceRecordValue],
      ttl: 600
    }
  );

  const certificateValidation = new aws.acm.CertificateValidation(
    `${parentDomain}-certificateValidation`,
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: [certificateValidationDomain.fqdn]
    },
    { provider: usEast1 }
  );
  return certificateValidation.certificateArn;
}

/**
 * Gets Widlcard certificate for top domain
 * @param domain {string} website domain name
 * @returns {pulumi.Output<pulumi.Unwrap<aws.acm.GetCertificateResult>>}
 */
export function getCertificate(domain: string) {
  const parentDomain = getParentDomain(domain);
  const usEast1 = new aws.Provider(`${domain}/get-provider/us-east-1`, {
    profile: aws.config.profile,
    region: aws.USEast1Region
  });
  const certificate = aws.acm.getCertificate(
    { domain: `*.${parentDomain}`, mostRecent: true, statuses: ["ISSUED"] },
    { provider: usEast1, async: true }
  );
  return pulumi.output(certificate);
}

function getParentDomain(domain: string) {
  const parentDomain = getDomainAndSubdomain(domain).parentDomain;
  return parentDomain.substr(0, parentDomain.length - 1);
}

function getRootDomain(domain: string) {
  const rootDomain = getDomainAndSubdomain(domain).rootDomain;
  return rootDomain.substr(0, rootDomain.length - 1);
}

/**
 * Split a domain name into its subdomain and parent domain names.
 * e.g. "www.example.com" => "www", "example.com".
 * @param domain
 * @returns {*}
 */
function getDomainAndSubdomain(domain: string) {
  const parts = domain.split(".");
  if (parts.length < 2) {
    throw new Error(`No TLD found on ${domain}`);
  }
  if (parts.length === 2) {
    return {
      subdomain: "",
      parentDomain: `${domain}.`,
      rootDomain: `${domain}.`
    };
  }

  const subdomain = parts.slice(0, parts.length - 2);
  const parent = parts.slice(1);
  const root = parts.slice(parts.length - 2);
  return {
    subdomain: subdomain.join("."),
    parentDomain: `${parent.join(".")}.`,
    rootDomain: `${root.join(".")}.`
  };
}

/**
 * WebSite component resource represents logical unit of static web site
 * hosted in AWS S3 and distributed via CloudFront CDN with Route53 DNS Record.
 */
export class Website extends pulumi.ComponentResource {
  contentBucket: aws.s3.Bucket;
  contentBucketPolicy: aws.s3.BucketPolicy;
  cdn?: aws.cloudfront.Distribution;
  dnsRecords: aws.route53.Record[];
  public domain: pulumi.Output<string>;
  public url: pulumi.Output<string>;

  get s3BucketUri(): pulumi.Output<string> {
    return this.contentBucket.bucket.apply(x => `s3://${x}`);
  }

  get s3WebsiteUrl(): pulumi.Output<string> {
    return this.contentBucket.websiteEndpoint.apply(x => `http://${x}`);
  }

  get cloudFrontId(): pulumi.Output<string> | undefined {
    return this.cdn?.id;
  }

  /**
   *
   * @param domain {string} domain name of the website
   * @param settings {*} optional overrides of website configuration
   * @param opts {pulumi.ComponentResourceOptions}
   */
  constructor(
    domain: string,
    settings: WebsiteSettings,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("topmonks-webs:WebSite", domain, settings, opts);
    this.domain = pulumi.output(domain);
    this.url = pulumi.output(`https://${domain}/`);
  }

  /**
   * Asynchronously creates new WebSite Resource
   * @param domain {string} website domain name
   * @param settings {*} optional overrides of website configuration
   * @param opts {pulumi.ComponentResourceOptions}
   * @returns {WebSite}
   */
  static create(
    domain: string,
    settings: WebsiteSettings,
    opts?: pulumi.ComponentResourceOptions
  ) {
    settings = {
      assetsPaths,
      assetsCachingLambdaArn,
      securityHeadersLambdaArn,
      ...settings
    };
    const website = new Website(domain, settings, opts);
    const contentBucket = createBucket(website, domain, settings.bucket || {});
    website.contentBucket = contentBucket;
    website.contentBucketPolicy = createBucketPolicy(
      website,
      domain,
      contentBucket
    );
    if (!settings.cdn?.disabled) {
      website.cdn = createCloudFront(
        website,
        domain,
        contentBucket,
        settings.isPwa,
        settings.assetsPaths,
        settings.assetsCachingLambdaArn,
        settings.securityHeadersLambdaArn,
        settings.edgeLambdas
      );
    }
    if (!settings.dns?.disabled) {
      website.dnsRecords = createAliasRecords(
        website,
        domain,
        contentBucket.bucketDomainName
      );
    }

    const outputs: pulumi.Inputs = {
      contentBucketUri: website.s3BucketUri,
      s3WebsiteUrl: website.s3WebsiteUrl,
      url: website.url,
      domain: website.domain,
      cloudFrontId: website.cloudFrontId
    };
    website.registerOutputs(outputs);
    return website;
  }

  static createRedirect(
    domain: string,
    settings: RedirectWebsiteSettings,
    opts?: pulumi.ComponentResourceOptions
  ): Website {
    const bucketSettings = {
      website: {
        redirectAllRequestsTo: settings.target
      }
    };
    const website = new Website(domain, { bucket: bucketSettings }, opts);
    const bucket = (website.contentBucket = createBucket(
      website,
      domain,
      bucketSettings
    ));
    website.contentBucketPolicy = createBucketPolicy(website, domain, bucket);
    website.cdn = createCloudFront(website, domain, bucket, false);
    website.dnsRecords = createAliasRecords(
      website,
      domain,
      bucket.bucketDomainName
    );
    return website;
  }
}

interface WebsiteSettings {
  isPwa?: boolean;
  bucket?: aws.s3.BucketArgs;
  cdn?: DisableSetting;
  dns?: DisableSetting;
  "lh-token"?: string;
  assetsPaths?: string[];
  assetsCachingLambdaArn?: string | pulumi.Output<string>;
  securityHeadersLambdaArn?: string | pulumi.Output<string>;
  edgeLambdas?: EdgeLambdaAssociation[];
}

interface EdgeLambdaAssociation {
  pathPattern: string;
  lambdaAssociation: {
    lambdaArn: string | pulumi.Output<string>;
    eventType: string;
  };
}

interface RedirectWebsiteSettings {
  target: string;
}

interface DisableSetting {
  disabled: boolean;
}
