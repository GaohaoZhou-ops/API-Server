let draft = null, epoch = 0;
const categories = ['使用问题', '接口与文档', '机器人模型', 'Web/APP UI', '功能建议', '其他'];
const imageTypes = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp'};
const megabyte = 1024 * 1024;

export function clearFeedbackDraft() {
  if (draft) draft.images = [];
  draft = null; epoch++;
  document.getElementById('feedback-form')?.reset();
}

export function renderFeedback({doc, heading, e, api, copy, codeVersion}) {
  heading('留言反馈', '告诉我们使用中遇到的问题或改进建议，便于进一步沟通。', '用户反馈');
  const current = epoch;
  draft ||= {name: '', email: '', organization: '', category: categories[0], message: '', images: [], id: null, receipt: null};
  const values = draft;
  const layout = e('div', undefined, 'feedback-layout');
  const form = e('form', undefined, 'feedback-form'); form.id = 'feedback-form';
  const grid = e('div', undefined, 'feedback-fields');
  const inputs = {};
  function field(key, label, options = {}) {
    const group = e('div', undefined, 'feedback-field' + (key === 'message' ? ' full' : ''));
    const title = e('label', label); title.htmlFor = 'feedback-' + key;
    if (key !== 'category') title.append(e('span', '必填', 'feedback-required'));
    const input = e(key === 'message' ? 'textarea' : key === 'category' ? 'select' : 'input');
    input.id = title.htmlFor; input.name = key;
    if (key === 'category') for (const value of categories) { const option = e('option', value); option.value = value; input.append(option); }
    else {
      input.required = true; input.maxLength = options.max;
      if (key === 'message') input.rows = 8; else input.type = key === 'email' ? 'email' : 'text';
      if (options.autocomplete) input.autocomplete = options.autocomplete;
      input.placeholder = options.placeholder || '';
    }
    input.value = values[key]; inputs[key] = input;
    input.oninput = () => {
      input.setCustomValidity(''); values[key] = input.value; values.id = null;
      if (key === 'message') count.textContent = input.value.length + ' / 3000';
    };
    group.append(title, input); grid.append(group);
    return group;
  }
  field('name', '姓名', {max: 80, autocomplete: 'name', placeholder: '你的姓名'});
  field('organization', '单位', {max: 160, autocomplete: 'organization', placeholder: '公司、学校或所属单位'});
  field('email', '邮箱地址', {max: 254, autocomplete: 'email', placeholder: 'name@example.com'});
  field('category', '反馈类型');
  const messageGroup = field('message', '留言内容', {max: 3000, placeholder: '请描述问题现象、复现步骤或你的建议。'});
  const count = e('span', values.message.length + ' / 3000', 'feedback-count');
  count.id = 'feedback-count'; inputs.message.setAttribute('aria-describedby', 'feedback-count'); messageGroup.append(count);
  const error = e('p', '', 'error feedback-error'); error.id = 'feedback-error'; error.setAttribute('role', 'alert');
  const upload = e('section', undefined, 'feedback-upload'); upload.setAttribute('aria-labelledby', 'feedback-upload-title');
  const uploadTitle = e('h3', '上传截图'); uploadTitle.id = 'feedback-upload-title'; uploadTitle.append(e('span', '可选', 'feedback-required'));
  const fileInput = e('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = '.png,.jpg,.jpeg,.webp';
  fileInput.hidden = true; fileInput.id = 'feedback-images'; fileInput.setAttribute('aria-label', '选择截图');
  const choose = e('button', '＋ 选择截图', 'secondary'); choose.type = 'button'; choose.onclick = () => fileInput.click();
  const uploadStatus = e('span', '', 'feedback-upload-count'); uploadStatus.setAttribute('role', 'status');
  const toolbar = e('div', undefined, 'feedback-upload-toolbar'); toolbar.append(choose, uploadStatus);
  const hint = e('p', '可拖入图片，最多 5 张。支持 PNG、JPG、WebP，每张不超过 5 MB，总计不超过 15 MB。', 'feedback-upload-hint');
  const previews = e('ul', undefined, 'feedback-image-list'); previews.setAttribute('aria-label', '待上传截图');
  upload.append(uploadTitle, toolbar, hint, fileInput, previews);
  function previewImage(item) {
    const dialog = e('dialog', undefined, 'feedback-image-dialog'); dialog.setAttribute('aria-label', '截图预览');
    const close = e('button', '关闭预览', 'secondary'); close.type = 'button'; close.onclick = () => dialog.close();
    const top = e('div', undefined, 'feedback-image-heading'); top.append(e('span', item.name), close);
    const img = e('img'); img.src = 'data:' + item.type + ';base64,' + item.data; img.alt = item.name;
    dialog.append(top, img); dialog.onclose = () => { img.removeAttribute('src'); dialog.remove(); };
    layout.append(dialog); dialog.showModal();
  }
  async function addImages(files) {
    if (values.sending || values.loadingImages || epoch !== current || !files.length) return;
    values.error = '';
    try {
      if (values.images.length + files.length > 5) throw new Error('一次最多上传 5 张截图，请先删除多余图片。');
      if (files.some(file => file.size > 5*megabyte)) throw new Error('每张截图不能超过 5 MB。');
      if (values.images.reduce((sum, item) => sum+item.size, 0) + files.reduce((sum, file) => sum+file.size, 0) > 15*megabyte)
        throw new Error('截图总大小不能超过 15 MB。');
      values.loadingImages = true; values.refresh();
      const selected = [];
      for (const file of files) {
        const type = imageTypes[file.name.split('.').at(-1).toLowerCase()];
        if (!type || (file.type && file.type !== type && !(type === 'image/jpeg' && file.type === 'image/jpg')))
          throw new Error('截图仅支持 PNG、JPG 和 WebP 图片。');
        const dataURL = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('图片读取失败，请重新选择。')); reader.readAsDataURL(file);
        });
        await new Promise((resolve, reject) => {
          const img = new Image(); img.onload = () => {
            if (img.naturalWidth > 16384 || img.naturalHeight > 16384 || img.naturalWidth*img.naturalHeight > 40000000)
              reject(new Error('截图尺寸过大，请缩小后上传。'));
            else resolve();
          };
          img.onerror = () => reject(new Error('图片无法读取，请选择有效的 PNG、JPG 或 WebP 图片。')); img.src = dataURL;
        });
        selected.push({name: file.name, type, size: file.size, data: dataURL.slice(dataURL.indexOf(',')+1)});
      }
      if (epoch === current) { values.images.push(...selected); values.id = null; }
    } catch (failure) { if (epoch === current) values.error = failure.message; }
    finally { values.loadingImages = false; fileInput.value = ''; values.refresh?.(); }
  }
  fileInput.onchange = () => addImages([...fileInput.files]);
  upload.ondragover = event => { event.preventDefault(); if (!values.sending) upload.classList.add('dragging'); };
  upload.ondragleave = () => upload.classList.remove('dragging');
  upload.ondrop = event => { event.preventDefault(); upload.classList.remove('dragging'); addImages([...event.dataTransfer.files]); };
  const submit = e('button', '提交留言', 'primary'); submit.type = 'submit'; submit.id = 'feedback-submit';
  const actions = e('div', undefined, 'feedback-actions'); actions.append(submit, e('span', '姓名、邮箱、单位和留言内容均需填写。'));
  form.append(grid, upload, error, actions);
  const receipt = e('section', undefined, 'feedback-receipt'); receipt.hidden = true;
  receipt.tabIndex = -1; receipt.setAttribute('role', 'status');
  function showReceipt() {
    if (!values.receipt) return;
    form.hidden = true; receipt.hidden = false; receipt.replaceChildren();
    const id = values.receipt.id;
    const number = e('div', undefined, 'feedback-receipt-number');
    const copyId = e('button', '复制编号', 'secondary feedback-copy-id'); copyId.type = 'button';
    copyId.onclick = () => copy(id);
    number.append(e('code', id, 'feedback-receipt-id'), copyId);
    receipt.append(e('span', '已提交', 'feedback-badge'), e('h2', '留言已收到'),
      e('p', `已保存你的留言${values.receipt.imageCount ? '和 ' + values.receipt.imageCount + ' 张截图' : ''}，并安排一同发送至管理员邮箱。请保留留言编号，便于后续沟通。`),
      e('p', '留言编号'), number);
    const again = e('button', '继续留言', 'secondary');
    again.onclick = () => {
      for (const [key, input] of Object.entries(inputs)) { input.value = key === 'category' ? categories[0] : ''; values[key] = input.value; }
      values.receipt = null; values.id = null; values.images = []; count.textContent = '0 / 3000'; values.refresh();
      receipt.hidden = true; form.hidden = false; inputs.name.focus();
    };
    receipt.append(again);
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (values.sending || values.loadingImages) return;
    error.textContent = '';
    for (const key of ['name', 'email', 'organization', 'message']) {
      inputs[key].value = inputs[key].value.trim(); values[key] = inputs[key].value;
      if (!values[key]) { inputs[key].setCustomValidity('请填写此项。'); inputs[key].reportValidity(); return; }
    }
    if (!form.reportValidity()) return;
    values.id ||= crypto.randomUUID(); values.sending = true;
    values.error = ''; values.refresh();
    try {
      const response = await api('/api/feedback', {submission_id: values.id, name: values.name,
        email: values.email, organization: values.organization, category: values.category,
        message: values.message, document_version: codeVersion,
        attachments: values.images.map(({name, type, data}) => ({name, type, data}))});
      if (epoch !== current) return;
      values.receipt = {id: response.id, created_at: response.created_at, imageCount: values.images.length};
      values.images = [];
      for (const key of ['name', 'email', 'organization', 'message']) { values[key] = ''; inputs[key].value = ''; }
    } catch (failure) {
      if (epoch === current) values.error = failure instanceof TypeError ? '网络连接中断，请重试；相同留言不会重复保存。' : failure.message;
    } finally {
      values.sending = false; values.refresh?.();
    }
  };
  const main = e('div'); main.append(form, receipt); layout.append(main);
  const info = e('aside', undefined, 'feedback-info');
  info.append(e('p', 'FEEDBACK', 'eyebrow'), e('h2', '帮助我们改进'),
    e('p', '欢迎反馈接口文档、机器人模型和使用体验中的问题，也可以提出新功能建议。'),
    e('h3', '仅管理员可见'), e('p', '联系信息、完整留言和所选截图会保存于服务器，并一同发送至管理员邮箱，用于反馈处理与后续联系。'),
    e('h3', '描述越具体，越便于处理'), e('p', '可附上相关接口或模型名称、问题现象和期望结果。请勿填写访问密码、邮箱授权码等敏感凭据。'));
  layout.append(info); doc.append(layout);
  values.refresh = () => {
    if (!form.isConnected || epoch !== current) return;
    const busy = !!(values.sending || values.loadingImages);
    submit.disabled = busy; submit.textContent = values.sending ? '正在提交…' : values.loadingImages ? '正在读取截图…' : '提交留言';
    for (const input of Object.values(inputs)) input.disabled = busy;
    choose.disabled = busy || values.images.length >= 5; fileInput.disabled = busy;
    uploadStatus.textContent = values.loadingImages ? '正在读取…' : `${values.images.length} / 5 张`;
    previews.replaceChildren();
    for (const [index, item] of values.images.entries()) {
      const entry = e('li', undefined, 'feedback-image');
      const thumb = e('button', undefined, 'feedback-image-preview'); thumb.type = 'button'; thumb.disabled = busy;
      thumb.setAttribute('aria-label', '预览 ' + item.name); thumb.onclick = () => previewImage(item);
      const img = e('img'); img.src = 'data:' + item.type + ';base64,' + item.data; img.alt = item.name; img.decoding = 'async'; thumb.append(img);
      const detail = e('div', undefined, 'feedback-image-detail');
      const name = e('span', item.name, 'feedback-image-name'); name.title = item.name;
      const remove = e('button', '删除', 'feedback-image-remove'); remove.type = 'button'; remove.disabled = busy;
      remove.setAttribute('aria-label', '删除 ' + item.name);
      remove.onclick = () => { if (!values.sending && !values.loadingImages) { values.images.splice(index, 1); values.id = null; values.error = ''; values.refresh(); } };
      const sizeLabel = item.size < megabyte ? Math.max(1, Math.round(item.size/1024)) + ' KB' : (item.size/megabyte).toFixed(2) + ' MB';
      detail.append(name, e('span', sizeLabel, 'feedback-image-size'), remove);
      entry.append(thumb, detail); previews.append(entry);
    }
    error.textContent = values.error || '';
    showReceipt();
    if (values.receipt) receipt.focus();
  };
  values.refresh();
}
