"use strict";

exports.handler = function (event, context, callback) {
  const response = event.Records[0].cf.response;
  const headers = response.headers;

  const addHeader = (headers, key, value) =>
    (headers[key.toLowerCase()] = [{ key, value }]);

  addHeader(headers, "Cache-Control", "public, max-age=31536000, immutable");

  callback(null, response);
};
