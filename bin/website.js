"use strict";
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Website = exports.createCertificate = exports.getHostedZone = exports.createGoogleMxRecords = exports.createTxtRecord = void 0;
const aws = require("@pulumi/aws");
const pulumi = require("@pulumi/pulumi");
const websiteConfig = new pulumi.Config("topmonks_website");
const assetsPaths = JSON.parse((_a = websiteConfig.get("assets_paths")) !== null && _a !== void 0 ? _a : "[]");
const assetsCachingLambdaArn = (_b = websiteConfig.get("assets_caching_lambda_arn")) !== null && _b !== void 0 ? _b : "";
const securityHeadersLambdaArn = (_c = websiteConfig.get("security_headers_lambda_arn")) !== null && _c !== void 0 ? _c : "";
/**
 * Creates S3 bucket with static website hosting enabled
 * @param parent {pulumi.ComponentResource} parent component
 * @param domain {string} website domain name
 * @param settings {aws.s3.BucketArgs}
 * @returns {aws.s3.Bucket}
 */
function createBucket(parent, domain, settings) {
    const website = settings.website || {
        indexDocument: "index.html",
        errorDocument: "404.html"
    };
    return new aws.s3.Bucket(`${domain}/bucket`, {
        bucket: domain,
        acl: "public-read",
        website,
        forceDestroy: true
    }, { parent });
}
/**
 * Creates Public read bucket policy
 * @param parent {pulumi.ComponentResource} parent component
 * @param domain {string} website domain name
 * @param bucket {aws.s3.Bucket}
 * @returns {aws.s3.BucketPolicy}
 */
function createBucketPolicy(parent, domain, bucket) {
    return new aws.s3.BucketPolicy(`${domain}/bucket-policy`, {
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
    }, { parent });
}
/**
 * Creates CloudFront distribution on top of S3 website
 * @param parent {pulumi.ComponentResource} parent component
 * @param domain {string} website domain name
 * @param contentBucket {aws.s3.Bucket}
 * @param isPwa {boolean}
 * @returns {aws.cloudfront.Distribution}
 */
function createCloudFront(parent, domain, contentBucket, isPwa) {
    const acmCertificate = getCertificate(domain);
    const customErrorResponses = [];
    if (isPwa)
        customErrorResponses.push({
            errorCode: 404,
            responseCode: 200,
            responsePagePath: "/index.html"
        });
    return new aws.cloudfront.Distribution(`${domain}/cdn-distribution`, {
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
                queryString: false
            },
            minTtl: 0,
            defaultTtl: 86400,
            maxTtl: 31536000,
            // enable gzip
            compress: true,
            lambdaFunctionAssociations: [
                // add lambda edge with security headers for A+ SSL Grade
                {
                    eventType: "viewer-response",
                    lambdaArn: securityHeadersLambdaArn
                }
            ]
        },
        orderedCacheBehaviors: assetsPaths.map(pathPattern => ({
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
            lambdaFunctionAssociations: [
                // add lambda edge with cache headers for immutable assets
                {
                    eventType: "viewer-response",
                    lambdaArn: assetsCachingLambdaArn
                }
            ]
        })),
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
    }, {
        parent,
        dependsOn: [contentBucket]
    });
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
function createAliasRecords(parent, domain, cname) {
    const hostedZone = getHostedZone(domain);
    const cdn = parent.cdn;
    if (!cdn) {
        const args = {
            name: domain,
            zoneId: hostedZone.apply(x => x.zoneId),
            ttl: 300,
            type: "CNAME",
            records: [cname]
        };
        return [new aws.route53.Record(`${domain}/dns-record`, args, { parent })];
    }
    const args = (type) => ({
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
function createTxtRecord(name, domain, value) {
    const hostedZone = getHostedZone(domain);
    return new aws.route53.Record(`${domain}/txt-record-${name}`, {
        name: hostedZone.apply(x => x.name),
        type: "TXT",
        zoneId: hostedZone.apply(x => x.zoneId),
        records: [value],
        ttl: 3600
    });
}
exports.createTxtRecord = createTxtRecord;
function createGoogleMxRecords(domain) {
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
exports.createGoogleMxRecords = createGoogleMxRecords;
function getHostedZone(domain) {
    const hostedZone = aws.route53.getZone({
        name: getRootDomain(domain)
    });
    return pulumi.output(hostedZone);
}
exports.getHostedZone = getHostedZone;
/**
 * Creates Widlcard certificate for top domain.
 * This creates certificate for root domain with wildcard for all subdomains.
 * You will need to have just one instance per all your stacks.
 * @param domain {string} website domain name
 * @returns {pulumi.Output<pulumi.Unwrap<aws.acm.GetCertificateResult>>}
 */
function createCertificate(domain) {
    const parentDomain = getParentDomain(domain);
    const usEast1 = new aws.Provider(`${domain}/provider/us-east-1`, {
        profile: aws.config.profile,
        region: aws.USEast1Region
    });
    const certificate = new aws.acm.Certificate(`${parentDomain}-certificate`, {
        domainName: `*.${parentDomain}`,
        subjectAlternativeNames: [parentDomain],
        validationMethod: "DNS"
    }, { provider: usEast1 });
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
    const certificateValidationDomain = new aws.route53.Record(`${parentDomain}-validationRecord`, {
        name: certificate.domainValidationOptions[0].resourceRecordName,
        zoneId: hostedZoneId,
        type: certificate.domainValidationOptions[0].resourceRecordType,
        records: [certificate.domainValidationOptions[0].resourceRecordValue],
        ttl: 600
    });
    const certificateValidation = new aws.acm.CertificateValidation(`${parentDomain}-certificateValidation`, {
        certificateArn: certificate.arn,
        validationRecordFqdns: [certificateValidationDomain.fqdn]
    }, { provider: usEast1 });
    return certificateValidation.certificateArn;
}
exports.createCertificate = createCertificate;
/**
 * Gets Widlcard certificate for top domain
 * @param domain {string} website domain name
 * @returns {pulumi.Output<pulumi.Unwrap<aws.acm.GetCertificateResult>>}
 */
function getCertificate(domain) {
    const parentDomain = getParentDomain(domain);
    const usEast1 = new aws.Provider(`${domain}/get-provider/us-east-1`, {
        profile: aws.config.profile,
        region: aws.USEast1Region
    });
    const certificate = aws.acm.getCertificate({ domain: `*.${parentDomain}`, mostRecent: true, statuses: ["ISSUED"] }, { provider: usEast1, async: true });
    return pulumi.output(certificate);
}
function getParentDomain(domain) {
    const parentDomain = getDomainAndSubdomain(domain).parentDomain;
    return parentDomain.substr(0, parentDomain.length - 1);
}
function getRootDomain(domain) {
    const rootDomain = getDomainAndSubdomain(domain).rootDomain;
    return rootDomain.substr(0, rootDomain.length - 1);
}
/**
 * Split a domain name into its subdomain and parent domain names.
 * e.g. "www.example.com" => "www", "example.com".
 * @param domain
 * @returns {*}
 */
function getDomainAndSubdomain(domain) {
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
class Website extends pulumi.ComponentResource {
    /**
     *
     * @param domain {string} domain name of the website
     * @param settings {*} optional overrides of website configuration
     * @param opts {pulumi.ComponentResourceOptions}
     */
    constructor(domain, settings, opts) {
        super("topmonks-webs:WebSite", domain, settings, opts);
        this.domain = pulumi.output(domain);
        this.url = pulumi.output(`https://${domain}/`);
    }
    get s3BucketUri() {
        return this.contentBucket.bucket.apply(x => `s3://${x}`);
    }
    get s3WebsiteUrl() {
        return this.contentBucket.websiteEndpoint.apply(x => `http://${x}`);
    }
    get cloudFrontId() {
        return this.cdn && this.cdn.id;
    }
    /**
     * Asynchronously creates new WebSite Resource
     * @param domain {string} website domain name
     * @param settings {*} optional overrides of website configuration
     * @param opts {pulumi.ComponentResourceOptions}
     * @returns {WebSite}
     */
    static create(domain, settings, opts) {
        var _a, _b;
        const website = new Website(domain, settings, opts);
        const contentBucket = createBucket(website, domain, settings.bucket || {});
        website.contentBucket = contentBucket;
        website.contentBucketPolicy = createBucketPolicy(website, domain, contentBucket);
        if (!((_a = settings.cdn) === null || _a === void 0 ? void 0 : _a.disabled)) {
            website.cdn = createCloudFront(website, domain, contentBucket, settings.isPwa);
        }
        if (!((_b = settings.dns) === null || _b === void 0 ? void 0 : _b.disabled)) {
            website.dnsRecords = createAliasRecords(website, domain, contentBucket.bucketDomainName);
        }
        const outputs = {
            contentBucketUri: website.s3BucketUri,
            s3WebsiteUrl: website.s3WebsiteUrl,
            url: website.url,
            domain: website.domain,
            cloudFrontId: website.cloudFrontId
        };
        website.registerOutputs(outputs);
        return website;
    }
    static createRedirect(domain, settings, opts) {
        const bucketSettings = {
            website: {
                redirectAllRequestsTo: settings.target
            }
        };
        const website = new Website(domain, { bucket: bucketSettings }, opts);
        const bucket = (website.contentBucket = createBucket(website, domain, bucketSettings));
        website.contentBucketPolicy = createBucketPolicy(website, domain, bucket);
        website.cdn = createCloudFront(website, domain, bucket, false);
        website.dnsRecords = createAliasRecords(website, domain, bucket.bucketDomainName);
        return website;
    }
}
exports.Website = Website;
//# sourceMappingURL=website.js.map