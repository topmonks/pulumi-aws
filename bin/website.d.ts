import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
/**
 * Creates Widlcard certificate for top domain.
 * This creates certificate for root domain with wildcard for all subdomains.
 * You will need to have just one instance per all your stacks.
 * @param domain {string} website domain name
 * @returns {pulumi.Output<pulumi.Unwrap<aws.acm.GetCertificateResult>>}
 */
export declare function createCertificate(domain: string): pulumi.Output<string>;
/**
 * WebSite component resource represents logical unit of static web site
 * hosted in AWS S3 and distributed via CloudFront CDN with Route53 DNS Record.
 */
export declare class Website extends pulumi.ComponentResource {
    contentBucket: aws.s3.Bucket;
    contentBucketPolicy: aws.s3.BucketPolicy;
    cdn?: aws.cloudfront.Distribution;
    dnsRecords: aws.route53.Record[];
    domain: pulumi.Output<string>;
    url: pulumi.Output<string>;
    get s3BucketUri(): pulumi.Output<string>;
    get s3WebsiteUrl(): pulumi.Output<string>;
    get cloudFrontId(): pulumi.Output<string> | undefined;
    /**
     *
     * @param domain {string} domain name of the website
     * @param settings {*} optional overrides of website configuration
     * @param opts {pulumi.ComponentResourceOptions}
     */
    constructor(domain: string, settings: WebsiteSettings, opts?: pulumi.ComponentResourceOptions);
    /**
     * Asynchronously creates new WebSite Resource
     * @param domain {string} website domain name
     * @param settings {*} optional overrides of website configuration
     * @param opts {pulumi.ComponentResourceOptions}
     * @returns {WebSite}
     */
    static create(domain: string, settings: WebsiteSettings, opts?: pulumi.ComponentResourceOptions): Website;
    static createRedirect(domain: string, settings: RedirectWebsiteSettings, opts?: pulumi.ComponentResourceOptions): Website;
}
interface WebsiteSettings {
    isPwa?: boolean;
    bucket?: aws.s3.BucketArgs;
    cdn?: DisableSetting;
    dns?: DisableSetting;
    "lh-token"?: string;
}
interface RedirectWebsiteSettings {
    target: string;
}
interface DisableSetting {
    disabled: boolean;
}
export {};
