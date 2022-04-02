export function handler(event) {
  const { response } = event.Records[0].cf;
  const headers = response.headers;

  const addHeader = (headers, key, value) =>
    (headers[key.toLowerCase()] = [{ key, value }]);

  addHeader(headers, "Cache-Control", "public, max-age=31536000, immutable");

  return response;
}
