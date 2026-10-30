export function resolveRef(spec, value, seen = new Set()) {
  if (!value?.$ref) return value || {};
  const ref = value.$ref;
  if (!ref.startsWith('#/') || seen.has(ref)) return {...value, unresolved: true};
  const keys = ref.slice(2).split('/').map(k => k.replaceAll('~1', '/').replaceAll('~0', '~'));
  let result = spec;
  for (const key of keys) result = result && Object.hasOwn(result, key) ? result[key] : undefined;
  if (!result) return {...value, unresolved: true};
  const next = new Set(seen); next.add(ref);
  const {$ref, ...extra} = value;
  return {...resolveRef(spec, result, next), ...extra};
}
export function operations(spec) {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
  return Object.entries(spec.paths || {}).flatMap(([path, raw]) => {
    const item = resolveRef(spec, raw);
    return Object.entries(item).filter(([method]) => methods.has(method)).map(([method, operation]) => ({
      ...operation, method: method.toUpperCase(), path,
      id: operation.operationId || `${method}:${path}`,
      parameters: [...(item.parameters || []), ...(operation.parameters || [])].map(p => resolveRef(spec, p)).filter((p, i, all) => all.findLastIndex(x => x.name === p.name && x.in === p.in) === i)
    }));
  });
}
export function sampleValue(spec, raw, depth = 0) {
  if (depth > 6) return null;
  const schema = resolveRef(spec, raw);
  if (schema.unresolved) return null;
  if (Object.hasOwn(schema, 'example')) return schema.example;
  if (schema.examples?.length) return schema.examples[0];
  if (Object.hasOwn(schema, 'default')) return schema.default;
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf || schema.anyOf) return sampleValue(spec, (schema.oneOf || schema.anyOf)[0], depth + 1);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map(s => sampleValue(spec, s, depth + 1)));
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  if (type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, sampleValue(spec, value, depth + 1)]));
  if (type === 'array') {
    if (schema.prefixItems) return schema.prefixItems.map(item => sampleValue(spec, item, depth + 1));
    return Array.from({length: Math.min(schema.minItems ?? 1, 128)}, () => sampleValue(spec, schema.items, depth + 1));
  }
  if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  return 'example';
}
export function mediaExample(spec, raw) {
  const value = resolveRef(spec, raw); const media = value.content?.['application/json'] || Object.values(value.content || {})[0];
  if (!media) return null;
  if (Object.hasOwn(media, 'example')) return media.example;
  if (media.examples) {
    const first = resolveRef(spec, Object.values(media.examples)[0]);
    if (Object.hasOwn(first, 'value')) return first.value;
  }
  return sampleValue(spec, media.schema || {});
}
export function typeLabel(spec, raw) {
  if (raw?.$ref) return raw.$ref.split('/').at(-1);
  const s = resolveRef(spec, raw);
  if (s.type === 'array') return `${typeLabel(spec, s.items)}[]`;
  if (s.oneOf || s.anyOf) return (s.oneOf || s.anyOf).map(x => typeLabel(spec, x)).join(' | ');
  return Array.isArray(s.type) ? s.type.join(' | ') : s.type || (s.properties ? 'object' : 'any');
}
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function requestExample(spec, operation, language = 'curl', exampleName) {
  const base = spec.servers?.[0]?.url || 'https://api.example.invalid';
  let route = operation.path; const query = new URLSearchParams();
  for (const p of operation.parameters || []) {
    const value = p.example ?? p.schema?.default ?? sampleValue(spec, p.schema);
    if (p.in === 'path') route = route.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    if (p.in === 'query' && (p.required || Object.hasOwn(p.schema || {}, 'default') || Object.hasOwn(p, 'example'))) query.set(p.name, String(value));
  }
  const url = base.replace(/\/$/, '') + route + (query.size ? '?' + query : '');
  const requestBody = resolveRef(spec, operation.requestBody);
  const contentType = Object.keys(requestBody.content || {})[0];
  const media = requestBody.content?.[contentType];
  let body = operation.requestBody ? mediaExample(spec, operation.requestBody) : null;
  if (exampleName && media?.examples?.[exampleName]) body = resolveRef(spec, media.examples[exampleName]).value;
  if (media && !Object.hasOwn(media, 'example') && !media.examples) {
    const schema = resolveRef(spec, media.schema);
    if (schema.properties && schema.required) body = Object.fromEntries(Object.entries(body || {}).filter(([key]) => schema.required.includes(key) || Object.hasOwn(schema.properties[key], 'default')));
  }
  const security = operation.security ?? spec.security ?? [];
  const headers = {Accept: 'application/json'};
  let cookieAuth = false;
  const success = Object.entries(operation.responses || {}).find(([status]) => /^2/.test(status))?.[1];
  const responseType = Object.keys(resolveRef(spec, success).content || {})[0] || 'application/json';
  const binary = responseType !== 'application/json';
  const filename = responseType === 'application/x-ndjson' ? 'response.ndjson'
    : responseType === 'image/jpeg' ? 'preview.jpg' : responseType === 'image/png' ? 'capture.png'
    : responseType === 'application/zip' ? 'download.zip'
    : operation.parameters?.some(p => p.in === 'path' && p.name === 'kind') ? 'capture.' + route.split('/').at(-1) : 'download.bin';
  const noContent = Object.hasOwn(operation.responses || {}, '204');
  if (binary) headers.Accept = responseType;
  for (const [name] of Object.entries(security[0] || {})) {
    const scheme = resolveRef(spec, spec.components?.securitySchemes?.[name]);
    if (scheme.type === 'http' && scheme.scheme === 'bearer') headers.Authorization = 'Bearer YOUR_API_TOKEN';
    if (scheme.type === 'apiKey' && scheme.in === 'header') headers[scheme.name] = 'YOUR_API_KEY';
    if (scheme.type === 'apiKey' && scheme.in === 'cookie') {
      cookieAuth = true;
      // Browsers send their HttpOnly cookie themselves; Cookie is a forbidden
      // fetch header. Other clients may use the exact login Set-Cookie name.
      if (language !== 'javascript') headers.Cookie = [headers.Cookie, scheme.name + '=YOUR_SESSION'].filter(Boolean).join('; ');
    }
  }
  for (const p of operation.parameters || []) if (p.in === 'header' && p.required) headers[p.name] = String(p.example ?? sampleValue(spec, p.schema));
  if (body !== null) headers['Content-Type'] = contentType || 'application/json';
  const form = contentType === 'application/x-www-form-urlencoded';
  const encoded = body === null ? null : form ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString() : JSON.stringify(body);
  if (language === 'javascript') return `${cookieAuth ? '// 在已登录的服务同源页面运行；浏览器自动携带 Cookie。\n' : ''}const response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(operation.method)},${cookieAuth ? '\n  credentials: "same-origin",' : ''}\n  headers: ${JSON.stringify(headers, null, 2).replaceAll('\n', '\n  ')}${body !== null ? ',\n  body: ' + (form ? JSON.stringify(encoded) : 'JSON.stringify(' + JSON.stringify(body, null, 2).replaceAll('\n', '\n  ') + ')') : ''}\n});\nif (!response.ok) throw new Error(await response.text());\n\nconst data = ${noContent ? 'response.status === 204 ? null : ' : ''}await response.${binary ? 'blob' : 'json'}();\nconsole.log(data);`;
  if (language === 'python') return `import json\n${binary ? 'from pathlib import Path\n' : ''}from urllib.request import Request, urlopen\n\nrequest = Request(\n    ${JSON.stringify(url)},\n    method=${JSON.stringify(operation.method)},\n    headers=${JSON.stringify(headers, null, 2).replaceAll('\n', '\n    ')}${body !== null ? ',\n    data=' + JSON.stringify(encoded) + '.encode("utf-8")' : ''}\n)\n\nwith urlopen(request, timeout=30) as response:\n    ${noContent ? 'if response.status != 204:\n        ' : ''}${binary ? 'Path(' + JSON.stringify(filename) + ').write_bytes(response.read())' : 'print(json.load(response))'}`;
  return [`curl --fail-with-body --request ${operation.method}`, `  --url ${shellQuote(url)}`, ...Object.entries(headers).map(([k, v]) => `  --header ${shellQuote(k + ': ' + v)}`), ...(body !== null ? form ? Object.entries(body).map(([k, v]) => `  --data-urlencode ${shellQuote(k + '=' + v)}`) : [`  --data ${shellQuote(JSON.stringify(body, null, 2))}`] : []), ...(binary ? ['  --output ' + filename] : [])].join(' \\\n');
}
