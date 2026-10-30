// Application submission never signs in or changes a password.
export function bindAccessRequest() {
  const $ = id => document.getElementById(id);
  const dialog = $('access-request-dialog'), form = $('access-request-form');
  const fields = ['name', 'email', 'organization'].map(name => $('request-' + name));
  let pending = false, submitted = false, submissionID, fingerprint, generation = 0, controller;
  function busy(value) {
    pending = value; form.setAttribute('aria-busy', String(value));
    for (const field of [...fields, $('access-request-submit'), $('access-request-close')]) field.disabled = value;
    $('access-request-progress').textContent = value ? '正在提交申请…' : '';
  }
  function reset() {
    generation++; controller?.abort(); busy(false); form.reset();
    submitted = false; submissionID = fingerprint = undefined;
    $('access-request-fields').hidden = false; $('access-request-success').hidden = true;
    $('access-request-error').textContent = '';
    dialog.setAttribute('aria-labelledby', 'access-request-title');
  }
  function close() { if (!pending) dialog.close(); }
  $('access-request-open').onclick = () => {
    if ($('access-request-open').disabled) return;
    dialog.showModal(); fields[0].focus();
  };
  $('access-request-close').onclick = close;
  $('access-request-done').onclick = close;
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (submitted) reset(); });
  form.onsubmit = async event => {
    event.preventDefault(); if (pending || submitted) return;
    for (const field of fields) field.value = field.value.trim();
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(fields.map(field => [field.name, field.value]));
    const current = JSON.stringify(data);
    // A timeout/retry reuses the same identifier, including when the server already saved it.
    if (current !== fingerprint) { fingerprint = current; submissionID = crypto.randomUUID(); }
    const ownGeneration = generation;
    const currentController = new AbortController(); controller = currentController;
    const timeout = setTimeout(() => currentController.abort(), 15000);
    busy(true); $('access-request-error').textContent = '';
    try {
      const response = await fetch('/api/access-requests', {method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'}, signal: currentController.signal,
        body: JSON.stringify({...data, submission_id: submissionID})});
      let result;
      try { result = await response.json(); }
      catch { throw new Error('申请服务暂不可用，请稍后重试。'); }
      if (!response.ok) throw new Error(result.error || '申请提交失败，请稍后重试。');
      if (!result || typeof result.id !== 'string') throw new Error('提交结果暂未确认，请重试。');
      if (ownGeneration !== generation) return;
      submitted = true; form.reset();
      $('access-request-fields').hidden = true; $('access-request-success').hidden = false;
      dialog.setAttribute('aria-labelledby', 'request-success-title');
      $('request-success-title').focus();
    } catch (error) {
      if (ownGeneration === generation) $('access-request-error').textContent = error.name === 'AbortError' || error instanceof TypeError
        ? '连接中断或超时，请重试；同一申请不会重复保存。' : error.message;
    } finally {
      clearTimeout(timeout); if (ownGeneration === generation) busy(false);
    }
  };
  return {clear() { dialog.close(); reset(); }};
}
