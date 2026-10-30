const statuses = {added: '新增', modified: '修改', removed: '删除', unchanged: '未变更'};
const kinds = {operation: '接口', schema: '数据模型', component: '其他定义', settings: '公共设置', file: '文件'};
const size = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`;

// Keep three unchanged context lines around each edit; gaps retain the original
// line numbers and can always be expanded with the full-view toggle.
export function visibleLines(lines, changesOnly) {
  if (!changesOnly) return lines;
  const keep = new Set();
  lines.forEach((line, index) => {
    if (line.kind !== 'equal') for (let i = Math.max(0, index - 3); i <= Math.min(lines.length - 1, index + 3); i++) keep.add(i);
  });
  const result = []; let skipped = 0;
  lines.forEach((line, index) => {
    if (!keep.has(index)) {skipped++; return;}
    if (skipped) {result.push({kind: 'gap', count: skipped}); skipped = 0;}
    result.push(line);
  });
  if (skipped) result.push({kind: 'gap', count: skipped});
  return result;
}

export async function renderComparison({doc, heading, e, api, isCurrent, initialKind = 'api'}) {
  heading('版本对比', '选择基准版本和目标版本，查看 API 定义的变化。', '开发资源');
  const panel = e('section', undefined, 'comparison'); doc.append(panel);
  const loading = e('p', '正在读取可选版本…', 'muted'); loading.setAttribute('role', 'status'); panel.append(loading);
  let options;
  try { options = await api('/api/compare/options'); }
  catch (error) { if (isCurrent()) loading.textContent = error.message; return; }
  if (!isCurrent()) return;
  panel.replaceChildren();
  let kind = initialKind, mode = 'changes', generation = 0, data = null, page = 1, detail = null, selectedKey = null;
  const tabs = e('div', undefined, 'compare-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '对比类型');
  const tabButtons = new Map();
  for (const [value, label] of [['api', 'API 接口']]) {
    const button = e('button', label); button.type = 'button'; button.onclick = () => {kind = value; setup();};
    tabButtons.set(value, button); tabs.append(button);
  }
  const form = e('form', undefined, 'compare-selection');
  function selectField(text, name) {
    const label = e('label', text), select = e('select'); select.name = name; select.setAttribute('aria-label', text);
    label.append(select); return {label, select};
  }
  const from = selectField('基准版本', 'from'), to = selectField('目标版本', 'to');
  const swap = e('button', '⇄', 'secondary compare-swap'); swap.type = 'button'; swap.title = '交换版本'; swap.setAttribute('aria-label', '交换版本');
  const submit = e('button', '开始对比', 'primary'); submit.type = 'submit';
  form.append(from.label, swap, to.label, submit);
  const hint = e('p', '', 'muted compare-hint'), status = e('p', '', 'compare-status'); status.setAttribute('role', 'status');
  const results = e('div', undefined, 'compare-results');
  const filters = e('div', undefined, 'compare-filters'), modes = e('div', undefined, 'compare-modes');
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '显示范围');
  const modeButtons = new Map();
  for (const [value, label] of [['changes', '仅看增量'], ['all', '全量对比']]) {
    const button = e('button', label); button.type = 'button'; button.onclick = () => {
      mode = value; page = 1; renderList(); if (detail) renderDetail();
    }; modeButtons.set(value, button); modes.append(button);
  }
  const search = e('input'); search.type = 'search'; search.placeholder = '搜索接口、模型或文件…'; search.setAttribute('aria-label', '筛选对比条目');
  const stateFilter = selectField('变更类型', 'status');
  for (const [value, label] of [['', '全部状态'], ...Object.entries(statuses)]) {const option = e('option', label); option.value = value; stateFilter.select.append(option);}
  stateFilter.label.className = 'sr-only-label';
  filters.append(modes, search, stateFilter.label);
  const summary = e('div', undefined, 'compare-counts'), listing = e('div', undefined, 'compare-list'), pager = e('nav', undefined, 'changelog-pagination');
  pager.setAttribute('aria-label', '对比条目翻页');
  const detailBox = e('section', undefined, 'compare-detail'); detailBox.hidden = true;
  results.append(summary, filters, listing, pager, detailBox); results.hidden = true;
  panel.append(tabs, form, hint, status, results);
  const current = ticket => isCurrent() && ticket === generation;
  const query = () => new URLSearchParams({kind, from: from.select.value, to: to.select.value});
  function invalidate() {
    generation++; data = null; detail = null; selectedKey = null; page = 1;
    results.hidden = true; detailBox.hidden = true; listing.replaceChildren(); detailBox.replaceChildren();
    submit.disabled = !from.select.value || !to.select.value || from.select.value === to.select.value;
    status.textContent = from.select.value === to.select.value && from.select.value ? '请选择两个不同版本。' : '选择完成后点击“开始对比”。';
    panel.removeAttribute('aria-busy');
  }
  function setup() {
    for (const [value, button] of tabButtons) button.setAttribute('aria-pressed', String(value === kind));
    const choices = options.api;
    for (const field of [from, to]) {
      field.select.replaceChildren();
      for (const item of [...choices].reverse()) {
        const option = e('option', item.label);
        option.value = item.id; field.select.append(option);
      }
    }
    // Only public, currently authorized resources are offered; no invented historical UI bundles.
    to.select.value = choices.at(-1)?.id || '';
    const earlier = choices.at(-2);
    from.select.value = earlier?.id || choices.at(-1)?.id || '';
    const enough = !!earlier;
    from.select.disabled = to.select.disabled = swap.disabled = !enough;
    search.value = ''; stateFilter.select.value = ''; invalidate();
    hint.textContent = '按公开的参数、响应、示例与说明比较；引用的数据模型变更也会标记到相关接口。';
    if (!enough) {
      submit.disabled = true;
      status.textContent = choices.length ? `当前只有一个可访问的 API 文档版本，至少需要两个版本才能对比。`
        : `暂无可对比的 API 文档版本。`;
    } else run();
  }
  async function run() {
    if (!from.select.value || !to.select.value || from.select.value === to.select.value) return;
    const ticket = ++generation;
    data = null; detail = null; selectedKey = null; page = 1; results.hidden = true; detailBox.hidden = true; detailBox.replaceChildren();
    status.textContent = '正在对比…'; panel.setAttribute('aria-busy', 'true'); submit.disabled = true;
    try {
      const value = await api('/api/compare?' + query());
      if (!current(ticket)) return;
      data = value; results.hidden = false;
      status.textContent = `${data.from.label} → ${data.to.label}`;
      summary.replaceChildren();
      for (const [key, label] of Object.entries(statuses)) summary.append(e('span', `${label} ${data.counts[key]}`, 'compare-badge ' + key));
      renderList();
    } catch (error) {if (current(ticket)) status.textContent = error.message;}
    finally {if (current(ticket)) {submit.disabled = false; panel.removeAttribute('aria-busy');}}
  }
  form.onsubmit = event => {event.preventDefault(); run();};
  from.select.onchange = to.select.onchange = invalidate;
  swap.onclick = () => {const value = from.select.value; from.select.value = to.select.value; to.select.value = value; invalidate(); run();};
  search.oninput = stateFilter.select.onchange = () => {page = 1; renderList();};
  function renderList() {
    if (!data) return;
    for (const [value, button] of modeButtons) button.setAttribute('aria-pressed', String(value === mode));
    const term = search.value.trim().toLowerCase();
    const items = data.items.filter(item => (mode === 'all' || item.status !== 'unchanged')
      && (!stateFilter.select.value || item.status === stateFilter.select.value)
      && `${item.label} ${item.path || ''} ${item.group || ''}`.toLowerCase().includes(term));
    const pages = Math.max(1, Math.ceil(items.length / 20)); page = Math.min(page, pages);
    listing.replaceChildren();
    for (const item of items.slice((page - 1) * 20, page * 20)) {
      const button = e('button', undefined, 'compare-row'); button.type = 'button'; button.dataset.key = item.key;
      button.setAttribute('aria-expanded', String(selectedKey === item.key));
      const name = e('span', undefined, 'compare-row-name');
      if (item.method) name.append(e('span', item.method, 'method ' + item.method.toLowerCase()));
      name.append(e('code', item.path || item.label));
      const caption = e('span', item.method ? item.label : kinds[item.kind], 'compare-row-caption');
      button.append(e('span', statuses[item.status], 'compare-badge ' + item.status), name, caption, e('span', '查看差异 →', 'compare-row-action'));
      button.onclick = () => showDetail(item); listing.append(button);
    }
    if (!items.length) listing.append(e('p', mode === 'changes' && !Object.values(data.counts).slice(0, 3).some(Boolean)
      ? '两个版本没有差异。可切换“全量对比”查看全部条目。' : '没有符合筛选条件的条目。', 'empty-state'));
    pager.replaceChildren(e('span', `共 ${items.length} 项 · 第 ${page} / ${pages} 页`, 'muted'));
    const buttons = e('div', undefined, 'changelog-page-buttons');
    for (const [text, target] of [['上一页', page - 1], ['下一页', page + 1]]) {
      const button = e('button', text, 'secondary'); button.disabled = target < 1 || target > pages;
      button.onclick = () => {page = target; renderList(); listing.scrollIntoView({block: 'start'});}; buttons.append(button);
    }
    pager.append(buttons);
  }
  async function showDetail(item) {
    const ticket = generation; selectedKey = item.key; detail = null; renderList();
    detailBox.hidden = false; detailBox.replaceChildren(e('p', '正在读取差异…', 'muted'));
    detailBox.scrollIntoView({block: 'start'});
    const params = query(); params.set('item', item.key);
    try {
      const value = await api('/api/compare?' + params);
      if (!current(ticket) || selectedKey !== item.key) return;
      detail = value; renderDetail();
    } catch (error) {if (current(ticket) && selectedKey === item.key) detailBox.replaceChildren(e('p', error.message));}
  }
  function renderDetail() {
    detailBox.replaceChildren();
    const item = detail.item, header = e('div', undefined, 'compare-detail-heading');
    const title = e('h2', item.path ? `${item.method} ${item.path}` : item.label); title.tabIndex = -1;
    const close = e('button', '收起', 'secondary'); close.onclick = () => {detailBox.hidden = true; detail = null; selectedKey = null; renderList();};
    header.append(title, close); detailBox.append(header);
    const meta = e('div', undefined, 'compare-detail-meta');
    for (const [name, value, version] of [['基准', item.before, detail.from.label], ['目标', item.after, detail.to.label]]) {
      const box = e('div'); box.append(e('strong', `${name} · ${version}`), e('p', value ? size(value.bytes) : '不存在'));
      if (value && detail.kind === 'web-ui') box.append(e('code', 'SHA-256 ' + value.sha256));
      meta.append(box);
    }
    detailBox.append(meta);
    if (!detail.lines) {
      detailBox.append(e('p', '二进制文件、非 UTF-8 文本或超出预览上限的文本仅展示大小与校验值。文本预览上限为 256 KiB、5000 行，可下载对应版本继续比较。', 'muted')); return;
    }
    const onlyEqual = detail.lines.every(line => line.kind === 'equal');
    if (onlyEqual) detailBox.append(e('p', item.status === 'modified'
      ? '文件字节有变化，但逐行文本相同（例如编码或换行符变化）。' : item.status === 'unchanged' ? '该条目未变更。' : '空文本文件。', 'muted'));
    const controls = e('div', undefined, 'compare-diff-tools');
    controls.append(e('span', '− 基准版本　＋ 目标版本', 'muted'));
    const toggle = e('button', mode === 'changes' ? '展开全部行' : '仅看变更行', 'secondary');
    toggle.onclick = () => {mode = mode === 'changes' ? 'all' : 'changes'; renderList(); renderDetail();}; controls.append(toggle); detailBox.append(controls);
    const viewport = e('div', undefined, 'compare-diff'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '逐行差异，左列为基准行号，右列为目标行号');
    const lines = e('pre');
    for (const line of visibleLines(detail.lines, mode === 'changes')) {
      const row = e('span', undefined, 'diff-line ' + line.kind);
      if (line.kind === 'gap') row.append(e('span', `… 隐藏 ${line.count} 行未变更内容 …`, 'diff-gap'));
      else {
        row.append(e('span', line.old ?? '', 'diff-number'), e('span', line.new ?? '', 'diff-number'),
          e('span', line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ', 'diff-sign'), e('span', line.text, 'diff-text'));
      }
      lines.append(row);
    }
    viewport.append(lines); detailBox.append(viewport);
  }
  setup();
}
