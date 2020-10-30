"use strict";

exports.handler = function (event, context, callback) {
  const response = event.Records[0].cf.response;
  const headers = response.headers;

  const addHeader = (headers, key, value) =>
    (headers[key.toLowerCase()] = [{ key, value }]);

  addHeader(headers, "Strict-Transport-Security", "max-age=31536000; preload");
  addHeader(headers, "X-Content-Type-Options", "nosniff");
  addHeader(headers, "X-Frame-Options", "SAMEORIGIN");
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

  callback(null, response);
};
