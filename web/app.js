import {resolveRef, operations, sampleValue, mediaExample, typeLabel, requestExample} from './openapi.mjs';
import {highlightCode, renderMarkdown} from './markdown.mjs';
import {createDiagram, disposeDiagrams, parseFlowchart} from './diagrams.mjs';
import {renderFeedback, clearFeedbackDraft} from './feedback.mjs';
import {renderAdminPanel} from './admin.mjs';
import {renderComparison} from './compare.mjs';
import {bindUsernameInput, bindOrganizationInput} from './login-name.mjs';
import {bindAccessRequest} from './access-request.mjs';

const $ = id => document.getElementById(id);
const usernameInput = bindUsernameInput($('username'));
const organizationInput = bindOrganizationInput($('organization'));
const accessRequest = bindAccessRequest();
let csrf = '', site, spec, ops = [], catalog = [], versions, searchIndex = [], authenticated = false, toastTimer;
let renderGeneration = 0, authGeneration = 0;
let administrator = false;
let renderedURL = '';
const icons = {
  search: ['M21 21l-4.4-4.4', 'M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0'],
  book: ['M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z', 'M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2'],
  layers: ['M12 3 2 8l10 5 10-5-10-5z', 'm2 12 10 5 10-5', 'm2 16 10 5 10-5'],
  home: ['m3 10 9-7 9 7v10H3z', 'M9 20v-7h6v7'],
  bolt: ['m13 2-9 12h7l-1 8 10-13h-8z'],
  key: ['M15 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12', 'm11 13-8 8H1v-4l7-7'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  eyeOff: ['M3 3l18 18', 'M10.6 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3 3.9', 'M6.5 6.5A22 22 0 0 0 2 12s3.5 7 10 7a13 13 0 0 0 5.5-1.5', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  code: ['m8 5-6 7 6 7', 'm16 5 6 7-6 7', 'm14 3-4 18'],
  cube: ['m12 2-9 5v10l9 5 9-5V7z', 'm3 7 9 5 9-5', 'M12 12v10', 'm7 4 10 6'],
  alert: ['m12 3 10 18H2z', 'M12 9v5', 'M12 17v.1'],
  clock: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', 'M12 6v6l4 2'],
  upload: ['M4 15v6h16v-6', 'M12 16V2', 'm7 7 5-5 5 5'],
  download: ['M4 15v6h16v-6', 'M12 2v14', 'm7 11 5 5 5-5'],
  info: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', 'M12 11v6', 'M12 7v.1'],
  arrow: ['M5 12h14', 'm14 7 5 5-5 5']
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  for (const d of icons[name] || icons.book) { const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
document.querySelectorAll('[data-icon]').forEach(node => node.replaceWith(icon(node.dataset.icon)));
function e(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function link(route, text, cls) { const n = e('a', text, cls); n.href = '#' + route; return n; }
function method(value) { return e('span', value, 'method ' + value.toLowerCase()); }
function toast(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 2400); }
async function copy(value) { try { await navigator.clipboard.writeText(value); toast('已复制'); } catch { toast('复制不可用，请选择文本后复制'); } }
function setError(text) { $('app-error').textContent = text || ''; $('app-error').hidden = !text; }
function closeMenu() { $('sidebar').classList.remove('open'); $('menu-overlay').hidden = true; $('open-menu').setAttribute('aria-expanded', 'false'); }
function setPasswordVisible(visible) {
  const label = visible ? '隐藏' : '显示';
  $('password').type = visible ? 'text' : 'password';
  const button = $('toggle-password');
  button.replaceChildren(icon(visible ? 'eyeOff' : 'eye'), e('span', label));
  button.setAttribute('aria-label', label + '密码'); button.title = label + '密码';
}
function setLoginPending(pending) {
  for (const id of ['username', 'organization', 'password', 'toggle-password', 'login-submit', 'access-request-open']) $(id).disabled = pending;
  $('login-form').setAttribute('aria-busy', String(pending));
}
function clearLoginFailure() {
  $('login-failure-dialog').returnValue = '';
  $('login-failure-dialog').close();
}
$('login-failure-retry').onclick = () => $('login-failure-dialog').close('retry');
$('login-failure-dialog').addEventListener('cancel', event => {
  event.preventDefault(); $('login-failure-dialog').close('retry');
});
$('login-failure-dialog').addEventListener('close', () => {
  if ($('login-failure-dialog').returnValue === 'retry' && !$('login').hidden && !$('password').disabled) {
    $('password').focus(); $('password').select();
  }
});
function showLogin() {
  clearLoginFailure();
  accessRequest.clear();
  administrator = false; $('admin-tab').hidden = true;
  disposeDiagrams(); clearFeedbackDraft(); authenticated = false; renderGeneration++; authGeneration++;
  site = null; spec = null; ops = []; catalog = []; versions = null; searchIndex = []; csrf = '';
  for (const id of ['document', 'context', 'navigation', 'search-results', 'version-select']) $(id).replaceChildren();
  $('search-dialog').close(); $('download-spec').removeAttribute('href');
  if ($('auth-loading')) $('auth-loading').hidden = true;
  $('login-error').textContent = ''; setLoginPending(false);
  usernameInput.clear();
  organizationInput.clear();
  setPasswordVisible(false); $('login').hidden = false; $('app').hidden = true; closeMenu();
}
async function api(route, data) {
  const generation = authGeneration;
  const response = await fetch(route, {method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: data === undefined ? {} : {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}, body: data === undefined ? undefined : JSON.stringify(data)});
  const value = await response.json();
  if (!response.ok) {
    if (generation === authGeneration && ((response.status === 401 && route !== '/api/login') || (response.status === 403 && route.startsWith('/api/admin')))) showLogin();
    throw Object.assign(new Error(value.error || '请求失败'), {status: response.status});
  }
  return value;
}
function note(title, text) {
  const node = e('div', undefined, 'content-note'); const body = e('div'); body.append(e('strong', title), e('p', text)); node.append(icon('info'), body); return node;
}
function breadcrumb(group, title) { const n = e('div', undefined, 'breadcrumb'); n.append(link('overview', '文档'), e('span', '/'), e('span', group)); if (title) n.append(e('span', '/'), e('span', title)); return n; }
function heading(title, description, group = '文档指南') {
  const doc = $('document'); doc.append(breadcrumb(group), e('h1', title)); if (description) doc.append(e('p', description, 'lead'));
  document.title = `${title} · ${site.name}`;
}
function sectionTitle(title, id) { const h = e('h2', title); h.id = id; $('document').append(h); return h; }
function codePanel(title, text, footer, language = 'plaintext') {
  let value = text;
  const node = e('section', undefined, 'code-panel'); const top = e('div', undefined, 'code-heading');
  const b = e('button', '复制', 'copy-button'); b.setAttribute('aria-label', '复制' + title); b.onclick = () => copy(value); top.append(e('span', title), b);
  const pre = e('pre'); const code = e('code', undefined, 'hljs'); pre.append(code); node.append(top, pre);
  function set(text, nextLanguage = language) {
    value = text; language = nextLanguage;
    // Only use escaped markup produced by the local syntax highlighter.
    code.innerHTML = highlightCode(text, language);
  }
  set(text);
  if (footer) node.append(e('div', footer, 'code-footer'));
  return {node, pre, set};
}
function table(columns, rows) {
  const wrap = e('div', undefined, 'table-scroll'), t = e('table'), head = e('thead'), tr = e('tr'), body = e('tbody');
  columns.forEach(c => tr.append(e('th', c))); head.append(tr); t.append(head);
  rows.forEach(values => { const row = e('tr'); values.forEach(value => { const cell = e('td'); cell.append(value instanceof Node ? value : document.createTextNode(String(value))); row.append(cell); }); body.append(row); });
  t.append(body); wrap.append(t); return wrap;
}
function guideSection(s, i) {
  const section = e('section', undefined, 'doc-section'), title = e('h2'); title.id = 'section-' + i;
  title.append(e('span', String(i + 1).padStart(2, '0'), 'step-number'), document.createTextNode(s.title)); section.append(title);
  if (s.text) section.append(e('p', s.text));
  if (s.table) section.append(table(s.table.columns, s.table.rows));
  if (s.items) { const list = e('ul', undefined, 'guide-list'); s.items.forEach(text => list.append(e('li', text))); section.append(list); }
  if (s.diagram) section.append(createDiagram(s.diagram, {title: s.title}));
  if (s.code) section.append(codePanel(s.code.language, s.code.text, undefined, s.code.language).node);
  return section;
}
function docCard(title, text, route, symbol) {
  const card = link(route, undefined, 'doc-card'); const marker = e('span', undefined, 'card-icon'); marker.append(icon(symbol));
  card.append(marker, e('span', '↗', 'card-arrow'), e('h3', title), e('p', text)); return card;
}
function endpointList(items) {
  const node = e('div', undefined, 'endpoint-list');
  for (const op of items) { const row = link('op/' + encodeURIComponent(op.id), undefined, 'endpoint-row'); row.append(method(op.method), e('code', op.path), e('span', op.summary, 'endpoint-summary')); node.append(row); }
  return items.length ? node : e('div', '尚未添加接口定义', 'empty-state');
}
function progressCard() {
  const card = e('section', undefined, 'context-card'); card.append(e('p', 'API VERSION', 'eyebrow'), e('h3', '产品 ' + site.version.product), e('p', '文档 ' + site.revision));
  card.append(e('p', '接口与示例需在目标环境验证。'));
  card.append(link('changelog', '查看版本增量 →'));
  return card;
}
function contextInfo() {
  const container = e('div', undefined, 'context-inner overview-context');
  const toc = e('nav', undefined, 'toc'); toc.setAttribute('aria-label', '本页目录'); toc.append(e('h3', '本页目录'));
  document.querySelectorAll('#document h2[id]').forEach(h => { const a = link(location.hash.slice(1) || 'overview', h.textContent); a.onclick = ev => { ev.preventDefault(); h.scrollIntoView({behavior: 'smooth', block: 'start'}); }; toc.append(a); });
  if (toc.children.length > 1) container.append(toc);
  container.append(progressCard());
  const meta = e('section', undefined, 'context-card'); meta.append(e('p', 'API DEFINITION', 'eyebrow'), e('h3', '统一的接口描述'), e('p', '下载后可导入支持 OpenAPI 的本地工具，查看接口并生成调用代码。'));
  meta.append(e('div', 'OpenAPI ' + spec.openapi + ' · ' + ops.length + ' 个已整理接口', 'base-url'));
  const download = e('a', '下载定义文件 ↓'); download.href = '/api/openapi.json?version=' + site.revision; download.download = 'api.openapi.json'; meta.append(download); container.append(meta);
  $('context').append(container);
}
function overview() {
  const doc = $('document'); doc.append(breadcrumb('开始使用'));
  const hero = e('section', undefined, 'hero'); hero.append(e('p', 'DOCUMENTATION / API', 'eyebrow'), e('h1', site.title), e('p', site.description, 'lead'));
  const actions = e('div', undefined, 'hero-actions'); actions.append(link(site.guides[0]?.id || 'reference', '快速开始  →', 'primary'), link('reference', '查阅 API', 'secondary')); hero.append(actions);
  const summary = e('div', undefined, 'home-summary');
  for (const [key, value] of [['产品版本', site.version.product], ['接口详解', String(ops.length)], ['索引条目', String(catalog.length)]]) { const n = e('span'); n.append(e('strong', key), document.createTextNode(value)); summary.append(n); }
  hero.append(summary); doc.append(hero);
  sectionTitle('从这里开始', 'start');
  const cards = e('div', undefined, 'cards');
  for (const page of site.guides) cards.append(docCard(page.title, page.description || '阅读指南', page.id, 'book'));
  cards.append(docCard('完整接口索引', '按方法和路径查找公开接口。', 'catalog', 'layers'), docCard('版本与更新', '接口变更与兼容性说明。', 'changelog', 'clock')); doc.append(cards);
  const section = e('div', undefined, 'section-title'); const h = e('h2', '接口预览'); h.id = 'preview'; section.append(h, link('reference', '查看全部 →')); doc.append(section, endpointList(ops.slice(0, 3)));
  doc.append(note('调用准备', '向接口提供方获取服务地址与凭据。文档站访问密码仅用于阅读文档；运行示例前请替换地址。'));
  contextInfo(); document.title = site.title + ' · ' + site.name;
}
function guide(id) {
  if (id === 'catalog') { heading('完整接口索引', '公开接口的方法与路径'); catalogTable(); contextInfo(); return; }
  const page = site.guides.find(g => g.id === id); if (!page) return notFound();
  heading(page.title, page.description);
  const rendered = renderMarkdown(page.markdown, {guides: site.guides, current: page.id});
  const body = e('div', undefined, 'markdown-body'); body.innerHTML = rendered.html;
  body.querySelectorAll('[data-copy-code]').forEach(button => button.onclick = () => copy(rendered.codeBlocks[Number(button.dataset.copyCode)]));
  body.querySelectorAll('[data-markdown-anchor]').forEach(anchor => anchor.onclick = event => {event.preventDefault(); document.getElementById(anchor.dataset.markdownAnchor)?.scrollIntoView({behavior: 'smooth'});});
  body.querySelectorAll('[data-diagram-index]').forEach(container => {try {container.replaceChildren(createDiagram(parseFlowchart(rendered.diagrams[Number(container.dataset.diagramIndex)])));} catch { /* Retain escaped code. */ }});
  $('document').append(body);
  if (id === 'catalog') catalogTable();
  contextInfo();
}
function reference() {
  heading('API 参考', '按模块浏览接口定义、请求参数与响应示例。', 'API 参考');
  if (spec['x-preview']) $('document').append(note('以下为文档示例', '这些接口用于预览文档布局，尚未接入真实工程，也不会在此页面发送请求。'));
  const links = e('div', undefined, 'hero-actions');
  links.append(link('catalog', '浏览 ' + catalog.length + ' 项接口索引 →', 'secondary'), link('compare', '对比 API 版本 →', 'secondary'));
  $('document').append(note('已整理 ' + ops.length + ' 个接口', '此处提供参数与示例；完整索引还列出其他接口的路径、访问条件和已整理字段。'), links);
  const input = e('input'); input.type = 'search'; input.placeholder = '筛选名称、路径或模块…'; input.setAttribute('aria-label', '筛选接口'); input.className = 'page-filter'; $('document').append(input);
  const results = e('div'); $('document').append(results);
  function update() {
    results.replaceChildren(); const q = input.value.trim().toLowerCase(); const filtered = ops.filter(op => JSON.stringify([op.summary,op.path,op.tags]).toLowerCase().includes(q));
    [...new Set(filtered.flatMap(o => o.tags || ['未分组']))].forEach((tag, i) => { const h=e('h2',tag); h.id='tag-'+i; results.append(h,endpointList(filtered.filter(o => o.tags?.includes(tag)))); });
    if (!filtered.length) results.append(e('p','没有匹配接口'));
  }
  input.oninput=update; update();
  if (!ops.length) $('document').append(e('div', '等待添加工程接口定义', 'empty-state'));
  contextInfo();
}
function fieldsTable(schema, parameters = false, depth = 0) {
  if (!parameters && depth < 6) {
    const resolved = resolveRef(spec, schema);
    const variants = resolved.oneOf || resolved.anyOf || resolved.allOf;
    if (variants && !resolved.properties) {
      const group = e('div', undefined, 'schema-variants');
      variants.forEach((variant, index) => {
        const part = e('section'); const title = variant.$ref ? typeLabel(spec, variant) : `结构 ${index + 1}`;
        part.append(e('h4', title), fieldsTable(variant, false, depth + 1)); group.append(part);
      });
      return group;
    }
  }
  const wrap = e('div', undefined, 'table-scroll'); const table = e('table'); const head = e('thead'); const tr = e('tr');
  for (const text of ['字段 / 类型', '说明']) tr.append(e('th', text)); head.append(tr); table.append(head);
  const rows = parameters ? schema : Object.entries(resolveRef(spec, schema).properties || {}).map(([name, field]) => ({name, schema: field, description: field.description, required: (resolveRef(spec, schema).required || []).includes(name)}));
  const body = e('tbody');
  for (const field of rows) {
    const s = resolveRef(spec, field.schema); const row = e('tr'); const name = e('td');
    const title = e('span', undefined, 'field-name'); title.append(document.createTextNode(field.name)); if (field.required) title.append(e('span', '必填', 'required'));
    name.append(title);
    if (field.schema?.$ref) name.append(link('schema/' + encodeURIComponent(field.schema.$ref.split('/').at(-1)), typeLabel(spec, field.schema), 'field-type schema-link'));
    else name.append(e('span', typeLabel(spec, field.schema), 'field-type'));
    const info = e('td', field.description || s.description || '—', 'field-description');
    const details = [];
    if (Object.hasOwn(s, 'default')) details.push('默认值：' + JSON.stringify(s.default));
    if (s.enum) details.push('可选值：' + s.enum.join(' / '));
    if (s.minimum !== undefined || s.maximum !== undefined) details.push(`范围：${s.minimum ?? '—'} ～ ${s.maximum ?? '—'}`);
    if (s.minLength !== undefined || s.maxLength !== undefined) details.push(`长度：${s.minLength ?? 0} ～ ${s.maxLength ?? '不限'}`);
    if (details.length) info.append(e('span', details.join('；'), 'field-detail'));
    row.append(name, info); body.append(row);
  }
  if (!rows.length) { const row = e('tr'); const cell = e('td', '该结构无已声明的对象字段，详见类型定义。'); cell.colSpan = 2; row.append(cell); body.append(row); }
  table.append(body); wrap.append(table); return wrap;
}
function operationPage(id) {
  const op = ops.find(o => o.id === id); if (!op) return notFound();
  heading(op.summary || op.id, op.description, 'API 参考');
  const doc = $('document'); const bar = e('div', undefined, 'path-bar'); bar.append(method(op.method), e('code', op.path)); const copyPath = e('button', '复制路径', 'copy-button'); copyPath.onclick = () => copy(op.path); bar.append(copyPath); doc.append(bar);
  const metadata = e('div', undefined, 'metadata-row');
  for (const [symbol, text] of [['key', op['x-access'] || '鉴权方式见接口定义'], ['layers', op.tags?.[0] || '未分组']]) { const n = e('span'); n.append(icon(symbol), document.createTextNode(text)); metadata.append(n); }
  if (spec['x-preview']) metadata.append(e('span', '示例接口', 'status-pill')); doc.append(metadata);
  for (const [kind, label] of [['path', '路径参数'], ['query', '查询参数'], ['header', '请求头参数'], ['cookie', 'Cookie 参数']]) {
    const params = (op.parameters || []).filter(p => p.in === kind);
    if (params.length) { sectionTitle(label, 'parameters-' + kind); doc.append(fieldsTable(params, true)); }
  }
  if (op.requestBody) {
    const body = resolveRef(spec, op.requestBody), type = Object.keys(body.content || {})[0]; sectionTitle('请求体', 'request-body'); doc.append(e('p', 'Content-Type: ' + type));
    doc.append(fieldsTable(body.content?.[type]?.schema || {}));
  }
  sectionTitle('响应结果', 'responses');
  const tabs = e('div', undefined, 'response-tabs'); const responseInfo = e('div'); doc.append(tabs, responseInfo);
  const right = e('div', undefined, 'context-inner reference-context');
  const req = codePanel('请求示例', requestExample(spec, op), spec['x-preview'] ? '示例地址不可调用。代码仅用于展示请求格式。' : '复制后按实际环境配置地址与凭证。', 'curl');
  let selectedLanguage = 'curl', selectedExample;
  const examples = Object.values(resolveRef(spec, op.requestBody).content || {})[0]?.examples;
  const updateExample = () => {
    req.set(requestExample(spec, op, selectedLanguage, selectedExample), selectedLanguage);
    response(exampleResponseCode());
  };
  if (examples && Object.keys(examples).length > 1) {
    const label = e('label', '操作示例 ', 'request-example-label');
    const select = e('select'); select.setAttribute('aria-label', '选择操作示例');
    for (const [key, example] of Object.entries(examples)) { const option = e('option', example.summary || key); option.value = key; select.append(option); }
    selectedExample = select.value;
    select.onchange = () => { selectedExample = select.value; updateExample(); };
    label.append(select); req.pre.before(label);
  }
  const languages = e('div', undefined, 'code-tabs'); languages.setAttribute('aria-label', '示例语言');
  for (const [value, title] of [['curl', 'cURL'], ['python', 'Python'], ['javascript', 'JavaScript']]) {
    const b = e('button', title, value === 'curl' ? 'active' : ''); b.setAttribute('aria-pressed', String(value === 'curl'));
    b.onclick = () => { languages.querySelectorAll('button').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); }); selectedLanguage = value; updateExample(); }; languages.append(b);
  }
  req.pre.before(languages); const res = codePanel('响应示例', '');
  const codes = Object.keys(op.responses || {});
  function exampleResponseCode() {
    return codes.find(code => op.responses[code].content?.['application/json']?.examples?.[selectedExample]) || codes[0];
  }
  function response(code) {
    const detail = resolveRef(spec, op.responses[code]); responseInfo.replaceChildren(e('p', detail.description || ''));
    const schema = detail.content?.['application/json']?.schema;
    if (schema) {
      const heading = e('div', undefined, 'metadata-row'); const label = typeLabel(spec, schema);
      heading.append(schema.$ref ? link('schema/' + encodeURIComponent(label), label, 'schema-link') : e('span', label)); responseInfo.append(heading, fieldsTable(schema));
    }
    const responseMedia = detail.content?.['application/json'];
    const example = responseMedia?.examples?.[selectedExample]?.value ?? mediaExample(spec, detail);
    res.set(!detail.content ? '无响应内容' : !schema ? '返回文件字节流；使用请求示例中的对应文件名保存。' : example === null ? '无响应内容' : JSON.stringify(example, null, 2), schema && example !== null ? 'json' : 'plaintext');
    tabs.querySelectorAll('button').forEach(b => { b.classList.toggle('active', b.dataset.code === code); b.setAttribute('aria-pressed', String(b.dataset.code === code)); });
  }
  for (const code of codes) { const b = e('button', code, 'response-tab' + (Number(code) >= 400 ? ' error-status' : '')); b.dataset.code = code; b.onclick = () => response(code); tabs.append(b); }
  if (codes.length) response(exampleResponseCode()); else responseInfo.append(e('p', '暂无响应定义'));
  right.append(req.node, res.node);
  const base = e('div', undefined, 'context-card'); base.append(e('p', 'BASE URL', 'eyebrow'), e('div', spec.servers?.[0]?.url || '待配置', 'base-url'), e('p', spec.servers?.[0]?.description || ''));
  const permalink = e('button', '复制此页链接 ↗', 'copy-button'); permalink.onclick = () => copy(location.href); base.append(permalink); right.append(base); $('context').append(right);
}
function models(selected) {
  heading(selected || '数据模型', '请求与响应字段；具体约束见对应接口说明。', '开发资源');
  let schemas = Object.entries(spec.components?.schemas || {});
  if (selected) schemas = schemas.filter(([name]) => name === selected);
  if (!schemas.length) { $('document').append(e('div', '尚无对应的数据模型', 'empty-state')); contextInfo(); return; }
  for (const [name, schema] of schemas) {
    const card = e('details', undefined, 'schema-card'); card.open = !!selected || name === schemas[0][0]; card.append(e('summary', name), e('p', schema.description || ''), fieldsTable(schema)); $('document').append(card);
  }
  if (selected) { $('document').append(link('models', '← 返回全部模型', 'secondary')); const card = codePanel('结构示例', JSON.stringify(sampleValue(spec, schemas[0][1]), null, 2), undefined, 'json'); $('context').append(card.node); }
  else contextInfo();
}
function changes() {
  heading('更新记录', '记录接口变更、兼容性说明与文档更新。时间为北京时间（UTC+8）。', '开发资源');
  const title = sectionTitle('文档修订', 'docs-changes'); title.tabIndex = -1;
  const entries = site.changelog.documentation || [], pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize)); let page = 0;
  const list = e('div'); list.id = 'changelog-entries';
  const formatter = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  function pagination(position) {
    const node = e('nav', undefined, 'changelog-pagination'); node.setAttribute('aria-label', '更新记录分页（' + position + '）');
    const status = e('p', undefined, 'changelog-page-status');
    if (position === '顶部') { status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true'); }
    const buttons = e('div', undefined, 'changelog-page-buttons');
    const previous = e('button', '上一页', 'secondary'), next = e('button', '下一页', 'secondary');
    for (const button of [previous, next]) { button.type = 'button'; button.setAttribute('aria-controls', list.id); }
    previous.onclick = () => showPage(page - 1, true); next.onclick = () => showPage(page + 1, true);
    buttons.append(previous, next); node.append(status, buttons); return {node, status, previous, next};
  }
  const controls = pageCount > 1 ? [pagination('顶部'), pagination('底部')] : [];
  if (controls.length) $('document').append(controls[0].node, list, controls[1].node); else $('document').append(list);
  function showPage(nextPage, scroll = false) {
    page = Math.max(0, Math.min(pageCount - 1, nextPage)); list.replaceChildren();
    for (const change of entries.slice(page * pageSize, (page + 1) * pageSize)) {
      const published = new Date(change.published_at || NaN), precise = Number.isFinite(published.getTime());
      const stamp = e('time', precise ? formatter.format(published) : change.date + '（具体时间未记录）', 'status-pill');
      stamp.dateTime = precise ? change.published_at : change.date;
      const n=e('section',undefined,'change-entry'); n.append(stamp,e('h3',change.version+' · '+change.title));
      for (const [key,label] of [['added','新增'],['changed','变更'],['compatibility','兼容性'],['validation','验证范围']]) if (change[key]?.length) { n.append(e('h4',label)); const ul=e('ul',undefined,'guide-list'); change[key].forEach(x=>ul.append(e('li',x))); n.append(ul); }
      list.append(n);
    }
    if (!entries.length) list.append(e('div', '暂无更新记录', 'empty-state'));
    for (const control of controls) {
      control.status.textContent = `第 ${page + 1} / ${pageCount} 页 · 共 ${entries.length} 次更新`;
      control.previous.disabled = page === 0; control.next.disabled = page === pageCount - 1;
    }
    if (scroll) { title.focus({preventScroll: true}); title.scrollIntoView({block: 'start'}); }
  }
  showPage(0);
  contextInfo();
}
function catalogTable() {
  sectionTitle('路由与允许字段', 'routes'); const input=e('input'); input.type='search'; input.placeholder='筛选路径、字段或访问分类…'; input.setAttribute('aria-label','筛选接口索引'); input.className='page-filter';
  const count=e('p'), area=e('div'); $('document').append(input,count,area);
  function update() {
    const items=catalog.filter(x=>JSON.stringify(x).toLowerCase().includes(input.value.toLowerCase())); count.textContent=items.length+' 个方法 / 路径';
    area.replaceChildren(table(['方法 / 路径','接口说明'],items.map(x=>{
      const route=e('div'); route.append(method(x.method),e('code',x.path,'catalog-path')); const detail=e('div');
      if(x.operationId) detail.append(link('op/'+encodeURIComponent(x.operationId),'参数与示例 →','schema-link'));
      detail.append(e('p',x.access)); if(x.fields) detail.append(e('p','允许字段：'+x.fields.join('、')),e('p',x.fieldNote));
      if (!x.operationId) detail.append(e('p','此历史修订仅收录路径，请切换到最新文档查看详解。')); return [route,detail];
    })));
  }
  input.oninput=update; update();
}
function notFound() { heading('页面不存在', '请选择目录中的接口或指南。'); contextInfo(); }
function buildNavigation() {
  const nav = $('navigation'); nav.replaceChildren();
  function title(text, badge) { const n = e('div', text, 'nav-heading'); if (badge) n.append(e('small', badge)); nav.append(n); }
  function item(id, title, symbol, op) { const a = link(id, undefined, 'nav-link' + (op ? ' endpoint' : '')); a.dataset.route = id; a.onclick = closeMenu; a.append(op ? method(op.method) : icon(symbol), e('span', title, 'nav-title')); nav.append(a); }
  if (site.revision) {
  title('文档首页'); item('overview', '项目概览', 'home');
  for (const group of [...new Set(site.guides.map(page => page.group))]) {
    title(group); for (const page of site.guides.filter(page => page.group === group)) item(page.id, page.title, 'book');
  }
  title('API 参考',String(ops.length)); item('reference','接口详解','code'); item('catalog','完整接口索引','code'); item('models','数据模型','cube');
  }
  title('版本'); item('compare','版本对比','layers');
  title('用户反馈'); item('feedback','留言反馈','info');
  $('admin-tab').hidden = !administrator;
  if (administrator) { title('管理'); item('admin', '管理员面板', 'key'); }
  if (site.revision) { title('维护与版本'); item('changelog','更新记录','clock'); }
  searchIndex = [{route: 'feedback', title: '留言反馈', description: '向管理员反馈使用问题与建议', keywords: '姓名 邮箱 单位 联系'}, {route: 'overview', title: '项目概览', description: site.title}, ...site.guides.map(g => ({route: g.id, title: g.title, description: g.description, keywords:g.markdown})), {route: 'reference', title: 'API 参考', description: '已整理的接口契约'}, {route: 'models', title: '数据模型', description: '请求与响应结构'}, {route: 'changelog', title: '更新记录', description: '文档与版本变更',keywords:JSON.stringify(site.changelog)}, ...ops.map(op => ({route: 'op/' + encodeURIComponent(op.id), title: op.summary, description: op.path, method: op.method, keywords: JSON.stringify(op)})), ...catalog.filter(x=>!x.operationId).map(x=>({route:'catalog',title:x.method+' '+x.path,description:x.access,keywords:(x.fields||[]).join(' ')})), ...Object.entries(spec.components?.schemas || {}).map(([name, s]) => ({route: 'schema/' + encodeURIComponent(name), title: name, description: s.description || '数据模型', keywords: Object.keys(s.properties || {}).join(' ')}))];
  searchIndex.unshift({route: 'compare', title: '版本对比', description: '对比两个版本的 API 接口', keywords: '全量 增量 差异 新增 修改 删除'});
  if (!site.revision) searchIndex = searchIndex.filter(item => ['feedback', 'compare'].includes(item.route));
  if (administrator) searchIndex.unshift({route: 'admin', title: '管理员面板', description: '密码、公司与部门权限、文档版本管理', keywords: '重置 删除 授权'});
}
function render() {
  if (!authenticated || !site) return;
  renderGeneration++;
  let raw = location.hash.slice(1) || 'overview', id;
  try { id = decodeURIComponent(raw); } catch { id = 'not-found'; }
  // A saved admin URL must be resolved against the current login's role.
  if (id === 'admin' && !administrator) {
    raw = id = site.revision ? 'overview' : 'feedback';
    const url = new URL(location.href); url.hash = raw;
    history.replaceState(null, '', url);
  }
  renderedURL = location.href;
  disposeDiagrams(); $('document').replaceChildren(); $('context').replaceChildren(); setError(''); closeMenu();
  const feedbackPage = id === 'feedback';
  const adminPage = id === 'admin';
  const comparePage = id === 'compare';
  const resourcePage = feedbackPage || adminPage || comparePage;
  $('document').parentElement.classList.toggle('model-download-layout', resourcePage);
  $('context').hidden = resourcePage || !site.revision; $('version-select').closest('label').hidden = resourcePage || !site.revision;
  $('notice').hidden = resourcePage || !site.notice;
  $('footer-status').textContent = comparePage ? 'API 版本对比' : adminPage ? '管理 · 仅管理员可用' : feedbackPage ? '留言反馈 · 仅管理员可见' : site.status;
  $('navigation').querySelectorAll('a').forEach(a => { const selected = a.dataset.route === raw || (comparePage && a.dataset.route === 'compare') || (id.startsWith('op/') && a.dataset.route === 'reference') || (id.startsWith('schema/') && a.dataset.route === 'models'); a.classList.toggle('active', selected); if (selected) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const apiPage = id === 'reference' || id.startsWith('op/') || id.startsWith('schema/') || ['models', 'catalog'].includes(id);
  for (const [tab, active] of [['guide-tab', !apiPage && !resourcePage], ['reference-tab', apiPage], ['compare-tab', comparePage], ['feedback-tab', feedbackPage], ['admin-tab', adminPage && administrator]]) {
    $(tab).classList.toggle('active', active);
    if (active) $(tab).setAttribute('aria-current', 'page'); else $(tab).removeAttribute('aria-current');
  }
  try {
    const generation = renderGeneration;
    if (adminPage) {
      if (administrator) renderAdminPanel({doc: $('document'), heading, e, api, copy, toast,
        isCurrent: () => generation === renderGeneration && authenticated && administrator, reloadDocuments: () => loadVersion('')});
      else heading('无管理权限', '请使用管理员密码登录。', '管理');
    }
    else if (comparePage) renderComparison({doc: $('document'), heading, e, api, initialKind: 'api',
      isCurrent: () => generation === renderGeneration && authenticated});
    else if (!resourcePage && !site.revision) heading('暂无可访问的 API 版本', '当前访问密码尚未获授权可用的 API 文档版本，请联系管理员。');
    else if (id === 'overview') overview(); else if (feedbackPage) renderFeedback({doc: $('document'), heading, e, api, copy, codeVersion: site.revision}); else if (id === 'reference') reference(); else if (id.startsWith('op/')) operationPage(id.slice(3)); else if (id === 'models' || id.startsWith('schema/')) models(id.startsWith('schema/') ? id.slice(7) : null); else if (id === 'changelog') changes(); else guide(id);
  } catch (err) { setError('文档渲染失败：' + err.message); }
  window.scrollTo(0, 0);
}
function search() {
  const query = $('search-input').value.trim().toLowerCase(); const results = query ? searchIndex.filter(x => `${x.title} ${x.description} ${x.keywords || ''}`.toLowerCase().includes(query)) : searchIndex.slice(0, 8);
  const area = $('search-results'); area.replaceChildren();
  for (const item of results.slice(0, 24)) { const a = link(item.route, undefined, 'search-result'); const title = e('div'); title.append(e('strong', item.title), e('p', item.description)); a.append(item.method ? method(item.method) : icon('book'), title); a.onclick = () => $('search-dialog').close(); area.append(a); }
  if (!results.length) area.append(e('div', '未找到匹配内容，试试接口路径或字段名。', 'search-empty'));
}
function openSearch() { if (!authenticated) return; $('search-input').value = ''; search(); $('search-dialog').showModal(); $('search-input').focus(); }
async function start(generation = authGeneration) {
  if (generation !== authGeneration) return;
  const session = await api('/api/session');
  if (generation !== authGeneration) return;
  csrf = session.csrf; administrator = session.admin === true;
  if ($('auth-loading-message')) $('auth-loading-message').textContent = '正在加载文档…';
  const requested = new URL(location.href).searchParams.get('version') || '';
  try { await loadVersion(requested, generation); }
  catch (error) {
    if (generation !== authGeneration) return;
    if (requested && [403, 404].includes(error.status)) await loadVersion('', generation); else throw error;
  }
}
async function loadVersion(version, generation = authGeneration) {
  if (generation !== authGeneration) return;
  const data = await api('/api/docs'+(version?'?version='+encodeURIComponent(version):''));
  if (generation !== authGeneration) return;
  site = data.site; spec = data.spec; catalog=data.catalog; versions=data.versions; ops = operations(spec); authenticated = true;
  clearLoginFailure();
  accessRequest.clear();
  const url=new URL(location.href);
  if (site.revision) url.searchParams.set('version',site.revision); else url.searchParams.delete('version');
  if (!site.revision && (!url.hash || url.hash === '#overview')) url.hash = '#feedback';
  history.replaceState(null,'',url);
  $('version-select').replaceChildren(); for(const v of versions.versions) {const o=e('option',v.label);o.value=v.id;$('version-select').append(o);} $('version-select').value=site.revision;
  $('site-name').textContent = site.name; $('project-name').textContent = site.projectName || site.title; $('project-stage').textContent = site.stageLabel;
  $('notice').hidden = !site.notice; $('notice').querySelector('span:nth-child(2)').textContent=site.notice;
  $('download-spec').hidden = !site.revision;
  if (site.revision) $('download-spec').href='/api/openapi.json?version='+site.revision; else $('download-spec').removeAttribute('href');
  if ($('auth-loading')) $('auth-loading').hidden = true;
  $('footer-status').textContent = site.status; $('login').hidden = true; $('app').hidden = false; buildNavigation(); render();
}
$('version-select').onchange=async()=>{const generation=authGeneration;try{await loadVersion($('version-select').value);}catch(err){if(generation===authGeneration){setError(err.message);if(site) $('version-select').value=site.revision;}}};
$('toggle-password').onclick = () => setPasswordVisible($('password').type === 'password');
$('login-form').onsubmit = async ev => {
  ev.preventDefault(); if ($('login-submit').disabled || usernameInput.composing || organizationInput.composing || $('login-failure-dialog').open) return;
  const username = usernameInput.value(); if (!username) return;
  const organization = organizationInput.value(); if (organization === null) return;
  const generation = ++authGeneration;
  setPasswordVisible(false); setLoginPending(true); $('login-error').textContent = '';
  try {
    const session = await api('/api/login', {username, organization, password: $('password').value});
    if (generation !== authGeneration) return;
    csrf = session.csrf; usernameInput.clear(); organizationInput.clear(); $('password').value = ''; await start(generation);
  } catch (err) {
    if (generation === authGeneration) {
      $('login-error').textContent = err.message;
      if (err.status === 401 && err.message === '访问密码错误' && !$('login').hidden) {
        $('login-failure-dialog').returnValue = '';
        $('login-failure-dialog').showModal();
      }
    }
  }
  finally { if (generation === authGeneration) setLoginPending(false); }
};
$('logout').onclick = async () => { const generation = authGeneration; try { await api('/api/logout', {}); if (generation === authGeneration) showLogin(); } catch (err) { if (generation === authGeneration) setError(err.message); } };
$('open-menu').onclick = () => { $('sidebar').classList.add('open'); $('menu-overlay').hidden = false; $('open-menu').setAttribute('aria-expanded', 'true'); };
$('close-menu').onclick = closeMenu; $('menu-overlay').onclick = closeMenu;
$('search-open').onclick = openSearch; $('search-close').onclick = () => $('search-dialog').close(); $('search-input').oninput = search;
$('search-input').onkeydown = ev => { if (ev.key === 'ArrowDown') { ev.preventDefault(); $('search-results').querySelector('a')?.focus(); } if (ev.key === 'Enter') { const first = $('search-results').querySelector('a'); if (first) { location.hash = first.hash; $('search-dialog').close(); } } };
document.addEventListener('keydown', ev => { if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openSearch(); } if (ev.key === 'Escape') closeMenu(); });
// Back/Forward may also change the version query; render once if both events fire.
function renderNavigation() { if (location.href !== renderedURL) render(); }
window.addEventListener('hashchange', renderNavigation);
window.addEventListener('popstate', renderNavigation);
document.querySelector('.skip-link').onclick = ev => { ev.preventDefault(); $('main-content').focus(); };
async function enter() {
  const generation = authGeneration;
  if (location.hash.startsWith('#device-auth=')) {
    // Strip retired invitation secrets; entry now uses ordinary password login.
    history.replaceState(null, '', location.pathname + location.search);
  }
  try { await start(generation); }
  catch (err) {
    if (generation !== authGeneration) return;
    showLogin(); if (!err.message.includes('请先登录')) $('login-error').textContent = err.message;
  }
}
setLoginPending(true);
enter();
