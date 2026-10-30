// Management capabilities come from /api/session and are enforced again by every API.
export async function renderAdminPanel({doc, heading, e, api, copy, toast, isCurrent, reloadDocuments}) {
  heading('管理员面板', '', '管理');
  const container = e('div', undefined, 'admin-panel'); doc.append(container);
  const status = e('p', '正在读取管理配置…', 'admin-status'); status.setAttribute('role', 'status');
  container.append(status);
  let snapshot, active = 'users', pending = false, viewGeneration = 0;
  let visitPage = 1, visitSnapshot = null, focusVisits = false;
  let requestPage = 1, requestSnapshot = null, focusRequests = false;
  const secrets = e('section', undefined, 'admin-secrets'); secrets.hidden = true;
  const navigation = e('nav', undefined, 'admin-tabs'); navigation.setAttribute('aria-label', '管理功能');
  const area = e('section', undefined, 'admin-area');
  const date = value => value ? new Date(value).toLocaleString('zh-CN', {hour12: false}) : '未记录';
  const scopeNames = {api_versions: 'API 文档'};
  const recordNames = {audit: '操作记录', visits: '访问记录', requests: '申请记录'};
  function button(text, action, cls = 'secondary') {
    const node = e('button', text, cls); node.type = 'button'; node.onclick = action; return node;
  }
  function field(title, control) { const label = e('label', undefined, 'admin-field'); label.append(e('span', title), control); return label; }
  function input(label, value = '') {
    const control = e('input'); control.value = value; control.required = true; control.maxLength = 120;
    control.setAttribute('aria-label', label); return control;
  }
  function secretRow(item, current = false) {
    const title = item.kind === 'shared' ? '全权限访问码' : `${item.company} / ${item.department}`;
    const row = e('div', undefined, 'admin-secret-row');
    const value = e('input'); value.value = item.password; value.readOnly = true; value.type = current ? 'text' : 'password';
    value.autocomplete = 'off'; value.spellcheck = false; value.placeholder = '未设置密码';
    value.setAttribute('aria-label', title + (current ? '当前密码' : '新密码'));
    const reveal = button(current ? '隐藏' : '显示', () => {
      value.type = value.type === 'password' ? 'text' : 'password'; reveal.textContent = value.type === 'password' ? '显示' : '隐藏';
    });
    const copyButton = button('复制', () => copy(value.value));
    if (!item.password) for (const node of [reveal, copyButton]) { node.disabled = true; node.dataset.locked = 'true'; }
    row.append(field(title, value), reveal, copyButton);
    return row;
  }
  function displaySecrets(items) {
    secrets.replaceChildren(); secrets.hidden = !items?.length;
    if (!items?.length) return;
    secrets.append(e('h2', '新访问密码'), e('p', '已保存到服务器配置。请及时复制分发；离开面板后不再显示。管理员密码未变更。'));
    for (const item of items) secrets.append(secretRow(item));
    secrets.append(button('复制全部新密码', () => copy(items.map(item => `${item.kind === 'shared' ? '全权限访问码' : item.company + ' / ' + item.department}\t${item.password}`).join('\n'))),
      button('收起并清除本次展示', () => { secrets.replaceChildren(); secrets.hidden = true; }));
  }
  async function mutate(action, data, message, dialog) {
    if (pending || !isCurrent()) return;
    pending = true; status.textContent = '正在保存…'; status.classList.remove('error');
    const controls = [...container.querySelectorAll('button, input, select')].map(node => [node, node.disabled]);
    controls.forEach(([node]) => node.disabled = true);
    try {
      const result = await api('/api/admin/' + action, {...data, revision: snapshot.revision});
      if (!isCurrent()) return;
      dialog?.close(); dialog?.remove();
      if (action === 'clear-records') {
        if (data.target === 'visits') { visitPage = 1; visitSnapshot = null; focusVisits = true; }
        if (data.target === 'requests') { requestPage = 1; requestSnapshot = null; focusRequests = true; }
        message = `已清理 ${result.cleared} 条${recordNames[data.target]}。`;
        toast(result.warning || message);
      }
      if (action === 'authorize-request') toast(result.queued ? '授权邮件已加入发送队列' : '该授权已提交，请查看发送状态');
      displaySecrets(result.generated);
      if (action === 'delete-document') { toast(message); await reloadDocuments(); return; }
      status.textContent = result.warning || message;
      try { snapshot = await api('/api/admin'); }
      catch (error) {
        // Do not discard newly generated credentials if the follow-up read fails.
        if (isCurrent()) {
          status.textContent = message + (result.generated?.length ? '请复制新密码后刷新面板。' : '请刷新面板。') + error.message;
          area.replaceChildren();
        }
        return;
      }
      if (isCurrent()) render();
    } catch (error) {
      if (isCurrent()) {
        status.textContent = error.message; status.classList.add('error');
        const errorBox = dialog?.querySelector('[role="alert"]'); if (errorBox) errorBox.textContent = error.message;
      }
    } finally {
      pending = false;
      if (action === 'clear-records') delete data.admin_password;
      if (isCurrent()) controls.forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; });
    }
  }
  function confirmation({title, description, word, extra, submit}) {
    const dialog = e('dialog', undefined, 'admin-confirm'); const form = e('form');
    const titleNode = e('h2', title); titleNode.id = 'admin-confirm-title';
    dialog.setAttribute('aria-labelledby', titleNode.id);
    const confirm = input('确认文字'); confirm.maxLength = 64; confirm.autocomplete = 'off';
    const error = e('p', '', 'error'); error.setAttribute('role', 'alert');
    const actions = e('div', undefined, 'admin-actions');
    const apply = button('确认' + title, null, 'admin-danger'); apply.type = 'submit';
    actions.append(button('取消', () => dialog.close()), apply);
    form.append(titleNode, e('p', description)); if (extra) form.append(extra);
    form.append(field(`输入「${word}」确认`, confirm), error, actions);
    form.onsubmit = event => {
      event.preventDefault();
      if (confirm.value !== word) { error.textContent = '确认文字不匹配。'; confirm.focus(); return; }
      submit(confirm.value, dialog);
    };
    dialog.oncancel = event => { if (pending) event.preventDefault(); };
    dialog.onclose = () => dialog.remove();
    dialog.append(form); container.append(dialog); dialog.showModal(); confirm.focus();
  }
  function clearRecords(target) {
    if (pending || !isCurrent()) return;
    const dialog = e('dialog', undefined, 'admin-confirm admin-record-clear'), form = e('form');
    const title = e('h2', '清理' + recordNames[target]); title.id = 'admin-clear-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const password = input('管理员密码'); password.type = 'password'; password.maxLength = 1024;
    password.autocomplete = 'current-password'; password.placeholder = '请输入管理员密码'; password.spellcheck = false;
    const error = e('p', '', 'error'); error.setAttribute('role', 'alert');
    const apply = button('确认清理', null, 'admin-danger'); apply.type = 'submit';
    const actions = e('div', undefined, 'admin-actions');
    actions.append(button('取消', () => { if (!pending) dialog.close(); }), apply);
    const detail = target === 'requests' ? '尚未发送的申请通知和授权邮件会一并取消；已启用的访问密码继续有效，已发送或正在发送的邮件无法撤回。' : '';
    form.append(title, e('p', `将清理全部${recordNames[target]}（包含其他页），此操作无法恢复。${detail}`),
      field('管理员密码', password), error, actions);
    form.onsubmit = async event => {
      event.preventDefault();
      if (pending || !isCurrent()) return;
      const value = password.value; password.value = ''; error.textContent = '';
      await mutate('clear-records', {target, admin_password: value}, '记录已清理。', dialog);
      if (isCurrent() && dialog.open) password.focus();
    };
    dialog.oncancel = event => { if (pending) event.preventDefault(); };
    dialog.onclose = () => { password.value = ''; dialog.replaceChildren(); dialog.remove(); };
    dialog.append(form); container.append(dialog); dialog.showModal(); password.focus();
  }
  function recordsHeader(title, target) {
    const header = e('div', undefined, 'admin-record-head');
    header.append(title, button('清理记录', () => clearRecords(target), 'admin-danger'));
    area.append(header);
  }
  function reset(target, identity = {}) {
    const all = target === 'all', shared = target === 'shared';
    const title = all ? '重置全部用户密码' : shared ? '重置全权限访问码' : '重置部门密码';
    confirmation({title, word: '重置', description: `${all ? '全权限访问码及所有部门密码（含停用部门）' : shared ? '全权限访问码' : identity.company + ' / ' + identity.department + ' 的密码'}将重新生成，旧密码与对应用户会话立即失效。管理员密码保持不变。`,
      submit: (confirm, dialog) => mutate('reset-passwords', {target, ...identity, confirm}, '密码已重置。', dialog)});
  }
  async function viewPasswords(target, identity = {}) {
    if (pending || !isCurrent()) return;
    const generation = viewGeneration;
    const dialog = e('dialog', undefined, 'admin-confirm admin-password-view');
    const title = e('h2', target === 'all' ? '当前全部用户密码' : target === 'request' ? '申请人的当前密码' : '当前密码'); title.id = 'admin-password-view-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const content = e('div'), loading = e('p', '正在读取当前密码…'); loading.setAttribute('role', 'status'); content.append(loading);
    const actions = e('div', undefined, 'admin-actions'); actions.append(button('关闭', () => dialog.close()));
    dialog.onclose = () => {
      dialog.querySelectorAll('input').forEach(node => node.value = ''); dialog.replaceChildren(); dialog.remove();
    };
    dialog.append(title, content, actions); container.append(dialog); dialog.showModal();
    try {
      const result = await api(target === 'request' ? '/api/admin/view-request-password' : '/api/admin/view-passwords',
        {...(target === 'request' ? {} : {target}), ...identity, revision: snapshot.revision});
      if (!isCurrent() || generation !== viewGeneration || !dialog.open || !dialog.isConnected) { dialog.close(); return; }
      content.replaceChildren(...result.passwords.map(item => secretRow(item, true)));
      if (result.notice) content.append(e('p', result.notice));
    } catch (error) {
      if (isCurrent() && generation === viewGeneration && dialog.open && dialog.isConnected) {
        loading.textContent = error.message; loading.classList.add('error'); loading.setAttribute('role', 'alert');
      }
    }
  }
  function users() {
    const intro = e('div', undefined, 'admin-section-head');
    intro.append(button('新增部门', () => editor())); area.append(intro);
    const editorArea = e('div'); area.append(editorArea);
    function editor(original) {
      editorArea.replaceChildren();
      const form = e('form', undefined, 'admin-editor');
      form.append(e('h3', original ? '编辑部门' : '新增部门'));
      const company = input('公司名称', original?.company), department = input('部门名称', original?.department);
      const companyOptions = e('datalist'), departmentOptions = e('datalist');
      companyOptions.id = 'admin-company-options'; departmentOptions.id = 'admin-department-options';
      company.setAttribute('list', companyOptions.id); department.setAttribute('list', departmentOptions.id);
      company.autocomplete = department.autocomplete = 'off';
      company.placeholder = '选择已有公司或输入新公司'; department.placeholder = '选择已有部门或输入新部门';
      function suggestions(list, values) {
        list.replaceChildren(...[...new Set(values)].map(value => { const option = e('option'); option.value = value; return option; }));
      }
      const knownCompanies = [...new Set(snapshot.departments.map(rule => rule.company))];
      suggestions(companyOptions, knownCompanies);
      function updateDepartments() {
        const selected = company.value.trim();
        const rules = knownCompanies.includes(selected) ? snapshot.departments.filter(rule => rule.company === selected) : snapshot.departments;
        suggestions(departmentOptions, rules.map(rule => rule.department));
      }
      company.addEventListener('input', updateDepartments); company.addEventListener('change', updateDepartments);
      updateDepartments();
      const enabled = e('input'); enabled.type = 'checkbox'; enabled.checked = original?.enabled ?? true;
      const enabledLabel = field('允许该部门登录', enabled); enabledLabel.classList.add('admin-check');
      const identity = e('div', undefined, 'admin-identity'); identity.append(field('公司名称', company), field('部门名称', department));
      form.append(identity, companyOptions, departmentOptions,
        e('p', '可下拉选择已有名称，也可手动输入新名称。选定已有公司后，部门列表显示该公司的已有部门；修改已有部门请使用“编辑权限”。'), enabledLabel);
      const controls = new Map(); const columns = e('div', undefined, 'admin-scopes');
      for (const [key, title] of Object.entries(scopeNames)) {
        const group = e('fieldset'); group.append(e('legend', title));
        const published = snapshot.choices[key]; const known = [...new Set([...published, ...(original?.[key] || [])])];
        controls.set(key, []);
        if (!known.length) group.append(e('p', '暂无已发布版本'));
        const options = e('div', undefined, 'admin-version-options');
        for (const version of known) {
          const check = e('input'); check.type = 'checkbox'; check.value = version; check.checked = original?.[key]?.includes(version) || false;
          const label = field(version + (published.includes(version) ? '' : '（未发布）'), check); label.classList.add('admin-check');
          options.append(label); controls.get(key).push(check);
        }
        group.append(options); columns.append(group);
      }
      form.append(columns, e('p', original ? '保存后，权限发生变化的部门需重新登录；现有密码保持不变。' : '保存后自动生成独立密码，请复制并交给该部门。'));
      const actions = e('div', undefined, 'admin-actions'), save = button('保存部门', null, 'primary'); save.type = 'submit';
      actions.append(save, button('取消编辑', () => editorArea.replaceChildren())); form.append(actions);
      form.onsubmit = event => {
        event.preventDefault();
        const data = {company: company.value.trim(), department: department.value.trim(), enabled: enabled.checked,
          original: original ? {company: original.company, department: original.department} : null};
        for (const [key, checks] of controls) data[key] = checks.filter(check => check.checked).map(check => check.value);
        mutate('save-department', data, '部门权限已保存。');
      };
      editorArea.append(form); company.focus(); editorArea.scrollIntoView({block: 'nearest'});
    }
    if (!snapshot.departments.length) area.append(e('div', '尚未配置部门。点击“新增部门”建立第一个机构账号。', 'empty-state'));
    const companies = new Map();
    for (const rule of snapshot.departments) {
      if (!companies.has(rule.company)) companies.set(rule.company, []); companies.get(rule.company).push(rule);
    }
    for (const [company, rules] of companies) {
      const group = e('section', undefined, 'admin-company'); group.append(e('h3', company));
      for (const rule of rules) {
        const row = e('div', undefined, 'admin-account-row'), detail = e('div');
        detail.append(e('strong', rule.department), e('span', rule.enabled ? '启用' : '停用', 'admin-badge'),
          e('p', Object.entries(scopeNames).map(([key, title]) => `${title}：${rule[key].length} 个授权版本`).join(' · ')));
        const identity = {company, department: rule.department};
        const actions = e('div', undefined, 'admin-actions'); actions.append(button('编辑权限', () => editor(rule)),
          button('重置密码', () => reset('department', identity)), button('查看当前密码', () => viewPasswords('department', identity)));
        row.append(detail, actions); group.append(row);
      }
      area.append(group);
    }
  }
  function passwords() {
    area.append(e('h2', '访问密码'));
    const rows = [
      ['管理员密码', '仅 admin_password 可进入此面板；在服务器 config/access.yaml 中维护。'],
      ['全权限访问码', 'access.yaml 的 password 仅拥有全部版本的阅读和下载权限，不具有管理权限。'],
      ['全部用户密码', `包含全权限访问码和 ${snapshot.departments.length} 个部门密码，保留管理员密码。`]
    ];
    for (const [index, [title, description]] of rows.entries()) {
      const card = e('section', undefined, 'admin-password-card'); card.append(e('h3', title), e('p', description));
      if (index === 1) card.append(e('p', '最近更新：' + date(snapshot.password_updated_at)));
      if (index > 0) {
        const actions = e('div', undefined, 'admin-actions'), target = index === 1 ? 'shared' : 'all';
        actions.append(button(index === 1 ? '重置全权限访问码' : '重置全部用户密码', () => reset(target), index === 1 ? 'secondary' : 'admin-danger'),
          button('查看当前密码', () => viewPasswords(target)));
        card.append(actions);
      }
      area.append(card);
    }
  }
  function documents() {
    area.append(e('h2', '在线文档版本'));
    for (const version of [...snapshot.documents.versions].reverse()) {
      const row = e('div', undefined, 'admin-account-row');
      const detail = e('div'); detail.append(e('strong', version.id));
      if (version.id === snapshot.documents.current) detail.append(e('span', '默认版本', 'admin-badge'));
      detail.append(e('p', '发布时间：' + (version.published_at ? date(version.published_at) : version.date || '未记录')));
      const remove = button('删除版本', () => {
        let replacement, extra;
        if (version.id === snapshot.documents.current) {
          replacement = e('select'); replacement.required = true;
          const placeholder = e('option', '请选择其他默认版本'); placeholder.value = ''; replacement.append(placeholder);
          for (const item of [...snapshot.documents.versions].reverse().filter(item => item.id !== version.id)) {
            const option = e('option', item.id); option.value = item.id; replacement.append(option);
          }
          extra = field('新的默认文档版本', replacement);
        }
        confirmation({title: '删除文档版本', description: `将从在线文档移除 ${version.id}。现有版本授权不会自动转移至其他版本。`, word: version.id, extra,
          submit: (confirm, dialog) => mutate('delete-document', {version: version.id, replacement: replacement?.value, confirm}, '文档版本已删除。', dialog)});
      }, 'admin-danger');
      remove.setAttribute('aria-label', '删除文档 ' + version.id);
      if (snapshot.documents.versions.length === 1) { remove.disabled = true; remove.dataset.locked = 'true'; remove.title = '至少保留一个版本'; }
      row.append(detail, remove); area.append(row);
    }
  }
  function history() {
    recordsHeader(e('h2', '最近管理操作'), 'audit');
    area.append(e('p', '显示最近 20 次操作；记录不包含密码或管理员邮箱。'));
    const names = {'save-department': '保存部门', 'reset-passwords': '重置密码', 'delete-document': '删除文档', 'clear-records': '清理记录', 'authorize-request': '申请访问授权', 'generate-request-password': '生成申请人密码'};
    if (!snapshot.audit.length) area.append(e('div', '暂无管理操作记录', 'empty-state'));
    for (const event of snapshot.audit) {
      const row = e('div', undefined, 'admin-audit-row');
      row.append(e('strong', names[event.action] || '管理操作'), e('span', date(event.time)),
        e('p', event.action === 'clear-records' ? `${recordNames[event.target] || '记录'}：${event.count} 条`
          : event.version || (event.company ? event.company + ' / ' + event.department : `重置 ${event.count} 个用户密码`)));
      area.append(row);
    }
  }
  async function visits(generation) {
    const title = e('h2', '访问记录', 'admin-visits-title'); title.tabIndex = -1;
    recordsHeader(title, 'visits');
    area.append(e('p', '全部成功登录记录，每页 10 条，最新在前。'));
    const loading = e('p', '正在读取访问记录…'); loading.setAttribute('role', 'status'); area.append(loading);
    try {
      const query = new URLSearchParams({page: String(visitPage)});
      if (visitSnapshot !== null) query.set('snapshot', String(visitSnapshot));
      const data = await api('/api/admin/visits?' + query);
      if (!isCurrent() || generation !== viewGeneration) return;
      visitPage = data.page; visitSnapshot = data.snapshot;
      loading.remove();
      function pagination(position) {
        const nav = e('nav', undefined, 'changelog-pagination admin-visits-pagination');
        nav.setAttribute('aria-label', '访问记录分页（' + position + '）');
        const summary = e('span', `共 ${data.total} 条 · 第 ${data.page} / ${data.pages} 页`, 'changelog-page-status');
        if (position === '顶部') summary.setAttribute('role', 'status');
        const controls = e('div', undefined, 'changelog-page-buttons');
        for (const [label, target] of [['首页', 1], ['上一页', data.page - 1], ['下一页', data.page + 1], ['末页', data.pages]]) {
          const change = button(label, () => {
            if (!isCurrent() || generation !== viewGeneration || pending) return;
            visitPage = target; focusVisits = true; render();
          });
          change.disabled = target < 1 || target > data.pages || target === data.page;
          controls.append(change);
        }
        nav.append(summary, controls); return nav;
      }
      area.append(pagination('顶部'));
      const labels = {admin: '管理员', shared: '全权限访问码', department: '部门密码', unknown: '未记录'};
      const list = e('ol', undefined, 'admin-visit-list'); list.setAttribute('aria-label', '成功登录记录');
      list.start = (data.page - 1) * data.limit + 1;
      for (const visit of data.visits) {
        const row = e('li', undefined, 'admin-visit-row'), top = e('div', undefined, 'admin-visit-heading');
        const time = e('time', date(visit.time)); time.dateTime = visit.time;
        top.append(time, e('span', labels[visit.loginType] || '未记录', 'admin-badge'));
        const metadata = e('dl', undefined, 'admin-visit-metadata');
        const unbound = ['shared', 'admin'].includes(visit.loginType) ? '未绑定' : '未记录';
        for (const [label, value] of [['用户名', visit.username], ['机构（填写）', visit.organization], ['公司', visit.company || unbound], ['部门', visit.department || unbound], ['IP', visit.ip], ['浏览器', visit.browser], ['操作系统', visit.os]]) {
          const field = e('div'); field.append(e('dt', label), e('dd', value || '未记录')); metadata.append(field);
        }
        row.append(top, metadata); list.append(row);
      }
      if (data.visits.length) area.append(list, pagination('底部'));
      else area.append(e('div', '暂无访问记录', 'empty-state'));
      if (focusVisits) { focusVisits = false; title.focus({preventScroll: true}); title.scrollIntoView({block: 'start'}); }
    } catch (error) {
      if (isCurrent() && generation === viewGeneration) {
        loading.textContent = error.message; loading.classList.add('error'); loading.setAttribute('role', 'alert');
        area.append(button('重试', () => { if (isCurrent() && generation === viewGeneration) render(); }));
      }
    }
  }
  function requestAuthorization(record, generation) {
    const form = e('form', undefined, 'admin-request-authorization');
    form.setAttribute('aria-label', record.name + '的访问授权');
    const grant = record.authorization;
    const view = button('查看当前密码', () => viewPasswords('request', {id: record.id, request_token: record.request_token,
      expected_grant_id: grant?.id || null}));
    view.disabled = !grant;
    if (!grant) view.title = '尚未授权，没有当前密码';
    const states = {pending: '授权邮件等待发送', sending: '授权邮件发送中', accepted: '授权邮件已受理',
      failed: '授权邮件发送失败', disabled: '授权邮件发送已关闭', uncertain: '授权邮件发送结果待确认', cancelled: '授权邮件已取消'};
    const reasons = {policy_changed: '部门密码或权限已变更，请核对后重新授权。',
      not_configured: '请检查邮件配置后重试。', auth_failed: '发件邮箱授权失败，请检查邮件配置。',
      recipient_rejected: '申请邮箱被邮件服务器拒绝。', tls_failed: '邮件加密连接失败，请稍后重试。',
      failed: '邮件发送失败，可生成新密码后重新授权。', interrupted: '上次发送中断，请先确认申请人是否已收到邮件。'};
    const state = e('p', grant ? states[grant.mail_status] || '授权状态待确认' : '尚未授权', 'request-authorization-status');
    state.setAttribute('role', 'status'); form.append(state);
    if (grant) form.append(e('p', `${grant.company} / ${grant.department} · ${date(grant.authorized_at)}`, 'request-authorization-detail'));
    if (reasons[grant?.mail_result]) form.append(e('p', reasons[grant.mail_result]));
    const available = snapshot.departments.filter(rule => rule.enabled && rule.has_password);
    if (!available.length) {
      form.append(e('p', '暂无可授权的部门。请先在“公司与部门”中创建或启用部门并配置版本权限。'));
      const actions = e('div', undefined, 'admin-actions'); actions.append(view); form.append(actions);
      return form;
    }
    const company = e('select'), department = e('select'); company.required = department.required = true;
    company.setAttribute('aria-label', '授权公司'); department.setAttribute('aria-label', '授权部门');
    function option(value, label = value) { const node = e('option', label); node.value = value; return node; }
    company.append(option('', '请选择公司'), ...[...new Set(available.map(rule => rule.company))].map(value => option(value)));
    if (available.some(rule => rule.company === grant?.company)) company.value = grant.company;
    const selection = e('div', undefined, 'admin-identity'); selection.append(field('授权公司', company), field('授权部门', department));
    const scope = e('p', '', 'request-authorization-detail');
    const apply = button('授权并发送密码', null, 'primary'); apply.type = 'submit';
    const generate = button('生成密码', generatePassword, 'secondary admin-generate-password');
    const preview = e('div', undefined, 'admin-generated-password'); preview.hidden = true;
    const password = e('input'); password.type = 'text'; password.readOnly = true; password.autocomplete = 'off'; password.spellcheck = false;
    password.setAttribute('aria-label', '生成的密码');
    const passwordRow = e('div', undefined, 'admin-secret-row');
    passwordRow.append(field('生成的密码（授权后生效）', password), button('复制密码', () => copy(password.value)));
    preview.append(passwordRow, e('p', '请在 30 分钟内完成授权。授权前该密码不可登录；权限沿用所选部门配置。', 'request-authorization-detail'));
    let operationId = crypto.randomUUID(), generationId = crypto.randomUUID(), draftId = null;
    const busy = ['pending', 'sending'].includes(grant?.mail_status);
    function clearPreview() { draftId = null; password.value = ''; preview.hidden = true; }
    function update() {
      const rule = available.find(rule => rule.company === company.value && rule.department === department.value);
      scope.textContent = rule ? Object.entries(scopeNames).map(([key, label]) => `${label}：${rule[key].length} 个授权版本`).join(' · ') : '请选择公司和部门。';
      const same = grant && grant.company === company.value && grant.department === department.value;
      apply.textContent = busy ? '授权邮件处理中' : same && grant.mail_status === 'accepted' ? '重新发送授权邮件'
        : same && ['failed', 'disabled', 'uncertain', 'cancelled'].includes(grant.mail_status) ? '重试授权邮件' : '授权并发送密码';
      apply.disabled = busy || !rule || !draftId;
      generate.disabled = busy || !rule;
    }
    async function generatePassword() {
      if (pending || busy || !company.value || !department.value || !isCurrent() || generation !== viewGeneration) return;
      clearPreview(); pending = true;
      const controls = [...container.querySelectorAll('button,input,select')].map(node => [node,node.disabled]);
      controls.forEach(([node]) => node.disabled = true);
      status.textContent = '正在生成独立访问密码…'; status.classList.remove('error');
      try {
        const result = await api('/api/admin/generate-request-password', {revision: snapshot.revision, id: record.id,
          request_token: record.request_token, company: company.value, department: department.value, operation_id: generationId});
        if (!isCurrent() || generation !== viewGeneration || !form.isConnected) return;
        password.value = result.password; draftId = result.draft_id; preview.hidden = false;
        generationId = crypto.randomUUID(); operationId = crypto.randomUUID();
        status.textContent = '独立密码已生成，点击“授权并发送密码”后启用并发送。';
        password.focus();
      } catch (error) {
        if (isCurrent() && generation === viewGeneration) { status.textContent = error.message; status.classList.add('error'); }
      } finally {
        pending = false;
        controls.forEach(([node,disabled]) => { if (node.isConnected) node.disabled = disabled; });
        if (isCurrent() && generation === viewGeneration) update();
      }
    }
    function departments(selected = '') {
      department.replaceChildren(option('', '请选择部门'), ...available.filter(rule => rule.company === company.value).map(rule => option(rule.department)));
      department.value = selected;
      department.disabled = busy || !company.value;
      update();
    }
    company.onchange = () => { clearPreview(); generationId = crypto.randomUUID(); operationId = crypto.randomUUID(); departments(); };
    department.onchange = () => { clearPreview(); generationId = crypto.randomUUID(); operationId = crypto.randomUUID(); update(); };
    company.disabled = busy;
    departments(grant?.department);
    const actions = e('div', undefined, 'admin-actions'); actions.append(generate, apply, view);
    form.append(selection, scope, e('p', '将生成的独立访问密码发送至 ' + record.email + '。权限沿用所选部门当前配置。', 'request-authorization-detail'), preview, actions);
    if (grant?.credential_type === 'individual') form.append(e('p', '重新授权后，仅此申请人的旧独立密码失效。', 'request-authorization-detail'));
    form.onsubmit = async event => {
      event.preventDefault();
      if (pending || busy || !draftId || !company.value || !department.value || !isCurrent() || generation !== viewGeneration) return;
      // Keep this operation ID after a lost response so a retry cannot send twice.
      await mutate('authorize-request', {id: record.id, request_token: record.request_token, company: company.value, department: department.value,
        operation_id: operationId, draft_id: draftId, expected_grant_id: grant?.id || null}, '授权已提交，请刷新面板查看邮件状态。');
    };
    return form;
  }
  async function requests(generation) {
    const title = e('h2', '申请记录', 'admin-visits-title'); title.tabIndex = -1;
    recordsHeader(title, 'requests');
    area.append(e('p', '核实申请信息后，选择公司和部门，先生成独立密码，再授权并发送。点击“刷新面板”查看邮件状态。'));
    const loading = e('p', '正在读取申请记录…'); loading.setAttribute('role', 'status'); area.append(loading);
    try {
      const query = new URLSearchParams({page: String(requestPage)});
      if (requestSnapshot !== null) query.set('snapshot', String(requestSnapshot));
      const [data, latest] = await Promise.all([api('/api/admin/access-requests?' + query), api('/api/admin')]);
      if (!isCurrent() || generation !== viewGeneration) return;
      snapshot = latest;
      requestPage = data.page; requestSnapshot = data.snapshot; loading.remove();
      function pagination(position) {
        const nav = e('nav', undefined, 'changelog-pagination admin-visits-pagination');
        nav.setAttribute('aria-label', '申请记录分页（' + position + '）');
        const summary = e('span', `共 ${data.total} 条 · 第 ${data.page} / ${data.pages} 页`, 'changelog-page-status');
        if (position === '顶部') summary.setAttribute('role', 'status');
        const controls = e('div', undefined, 'changelog-page-buttons');
        for (const [label, target] of [['首页', 1], ['上一页', data.page - 1], ['下一页', data.page + 1], ['末页', data.pages]]) {
          const change = button(label, () => {
            if (!isCurrent() || generation !== viewGeneration || pending) return;
            requestPage = target; focusRequests = true; render();
          });
          change.disabled = target < 1 || target > data.pages || target === data.page; controls.append(change);
        }
        nav.append(summary, controls); return nav;
      }
      area.append(pagination('顶部'));
      const labels = {pending: '等待发送', sending: '发送中', accepted: '邮件已受理', failed: '发送失败', disabled: '通知已关闭', uncertain: '发送结果待确认'};
      const reasons = {not_configured: '邮件配置不完整', auth_failed: '发信授权失败', recipient_rejected: '收件被拒绝', tls_failed: '加密连接失败', failed: '网络或邮件服务异常', interrupted: '发送中断，请先确认管理员是否已收到邮件'};
      const list = e('ol', undefined, 'admin-visit-list'); list.setAttribute('aria-label', '访问申请记录');
      list.start = (data.page - 1) * data.limit + 1;
      for (const record of data.requests) {
        const row = e('li', undefined, 'admin-visit-row admin-request-row'), top = e('div', undefined, 'admin-visit-heading');
        row.dataset.requestId = record.id;
        const time = e('time', date(record.created_at)); time.dateTime = record.created_at;
        const badge = e('span', '申请通知：' + (labels[record.mail_status] || '状态待确认'), 'admin-badge request-mail-status');
        badge.dataset.state = record.mail_status; top.append(time, badge);
        const metadata = e('dl', undefined, 'admin-visit-metadata');
        for (const [label, value] of [['姓名', record.name], ['邮箱', record.email], ['机构', record.organization]]) {
          const field = e('div'); field.append(e('dt', label), e('dd', value)); metadata.append(field);
        }
        row.append(top, metadata, e('p', '申请编号：' + record.id, 'request-record-id'));
        if (reasons[record.mail_result]) row.append(e('p', reasons[record.mail_result]));
        if (['failed', 'disabled', 'uncertain'].includes(record.mail_status)) {
          const retry = button('重试邮件', async () => {
            if (pending || !isCurrent() || generation !== viewGeneration) return;
            if (record.mail_status === 'uncertain' && !window.confirm('上次邮件可能已送达。确认再次发送此申请通知？')) return;
            pending = true; retry.disabled = true;
            try {
              const result = await api('/api/admin/access-requests/retry', {id: record.id});
              if (!isCurrent() || generation !== viewGeneration) return;
              toast(result.queued ? '已加入邮件重试队列' : '邮件已在队列中或已发送'); render();
            } catch (error) {
              if (isCurrent() && generation === viewGeneration) { status.textContent = error.message; status.classList.add('error'); }
            } finally { pending = false; retry.disabled = false; }
          });
          row.append(retry);
        }
        row.append(requestAuthorization(record, generation));
        list.append(row);
      }
      if (data.requests.length) area.append(list, pagination('底部'));
      else area.append(e('div', '暂无访问申请', 'empty-state'));
      if (focusRequests) { focusRequests = false; title.focus({preventScroll: true}); title.scrollIntoView({block: 'start'}); }
    } catch (error) {
      if (isCurrent() && generation === viewGeneration) {
        loading.textContent = error.message; loading.classList.add('error'); loading.setAttribute('role', 'alert');
        area.append(button('重试', () => { if (isCurrent() && generation === viewGeneration) render(); }));
      }
    }
  }
  const refresh = button('刷新面板', async () => {
    if (pending) return;
    if (active === 'visits') { visitPage = 1; visitSnapshot = null; focusVisits = false; render(); return; }
    if (active === 'requests') { requestPage = 1; requestSnapshot = null; focusRequests = false; render(); return; }
    try { const latest = await api('/api/admin'); if (isCurrent()) {snapshot = latest; render(); status.textContent = '配置已刷新。'; status.classList.remove('error');} }
    catch (error) { if (isCurrent()) {status.textContent = error.message; status.classList.add('error');} }
  }, 'secondary admin-refresh');
  function render() {
    const generation = ++viewGeneration;
    container.querySelectorAll('.admin-password-view').forEach(dialog => dialog.close());
    navigation.replaceChildren(); area.replaceChildren();
    const trailing = e('div', undefined, 'admin-tab-actions');
    for (const [key, label] of [['users', '公司与部门'], ['passwords', '访问密码'], ['documents', '文档版本'], ['history', '操作记录'], ['visits', '访问记录'], ['requests', '申请记录']]) {
      const tab = button(label, () => {
        if (!pending) {
          if (key === 'visits' && active !== 'visits') { visitPage = 1; visitSnapshot = null; focusVisits = false; }
          if (key === 'requests' && active !== 'requests') { requestPage = 1; requestSnapshot = null; focusRequests = false; }
          active = key; render();
        }
      });
      if (active === key) { tab.classList.add('active'); tab.setAttribute('aria-current', 'page'); }
      (['history', 'visits', 'requests'].includes(key) ? trailing : navigation).append(tab);
    }
    trailing.append(refresh); navigation.append(trailing);
    if (active === 'visits') { status.textContent = ''; status.classList.remove('error'); visits(generation); }
    else if (active === 'requests') { status.textContent = ''; status.classList.remove('error'); requests(generation); }
    else ({users, passwords, documents, history}[active])();
  }
  try {
    snapshot = await api('/api/admin'); if (!isCurrent()) return;
    status.textContent = '';
    container.append(secrets, navigation, area);
    render();
  } catch (error) { if (isCurrent()) { status.textContent = error.message; status.classList.add('error'); } }
}
