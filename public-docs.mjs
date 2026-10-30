import {validateOpenAPI, validateBundle} from './document-protocol.mjs';

export function publicOpenAPI(spec) {
  validateOpenAPI(spec);
  return {...spec, paths: spec.paths || {}, components: spec.components || {}};
}
const emptySpec = {openapi: '3.1.0', info: {title: 'API Docs', version: '0'}, paths: {}, components: {}};
export function emptyDocs() {
  return {site: {name: 'API Docs', title: '文档中心', revision: '', description: '', projectName: '文档中心', stageLabel: '暂无授权版本', status: '', notice: '', version: {product: ''}, guides: [], changelog: {documentation: []}}, spec: emptySpec, catalog: [], versions: {current: '', versions: []}};
}
export function publicDocs({bundle, versions}) {
  validateBundle(bundle);
  const {manifest, markdown} = bundle;
  const spec = publicOpenAPI(bundle.openapi || {...emptySpec, info: {title: manifest.site.title, version: manifest.productVersion}});
  const guides = manifest.guides.map(({id, title, group, description, file}) => ({id, title, group, file, description: description || '', markdown: markdown[id]}));
  const catalog = Object.entries(spec.paths).flatMap(([route, item]) => Object.entries(item).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(method)).map(([method, operation]) => ({method: method.toUpperCase(), path: route, operationId: operation.operationId, access: operation.summary || operation.description || ''})));
  return {
    site: {...manifest.site, revision: manifest.revision, projectName: manifest.site.title, stageLabel: manifest.productVersion + ' · ' + manifest.revision, status: '接口说明与调用示例', notice: '', version: {product: manifest.productVersion}, guides,
      changelog: {documentation: manifest.changes ? [{...manifest.changes, version: manifest.revision, published_at: manifest.publishedAt}] : []}},
    spec, catalog, versions: {current: versions.current, versions: versions.versions.map(({id, label, version, published_at}) => ({id, label, version, published_at}))}
  };
}
