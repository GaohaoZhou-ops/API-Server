export const USERNAME_LIMIT = 60;
export const USERNAME_ERROR = '请输入用户名，仅支持汉字、英文字母和空格，最多 60 个字。';
export const ORGANIZATION_LIMIT = 160;
export const ORGANIZATION_ERROR = '机构最多 160 个字，请勿使用换行或控制字符。';

// Visitor-supplied metadata only; organization names may include digits and punctuation.
export function validateOrganization(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return null;
  const normalized = value.normalize('NFC').trim();
  return [...normalized].length <= ORGANIZATION_LIMIT ? normalized : null;
}

export function bindOrganizationInput(input) {
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; input.setCustomValidity(''); });
  input.addEventListener('input', () => input.setCustomValidity(''));
  return {
    get composing() { return composing; },
    value() {
      if (composing) return null;
      const organization = validateOrganization(input.value);
      input.setCustomValidity(organization === null ? ORGANIZATION_ERROR : '');
      if (organization === null) input.reportValidity();
      else input.value = organization;
      return organization;
    },
    clear() { composing = false; input.value = ''; input.setCustomValidity(''); }
  };
}

const allowed = char => char === ' ' || (/^\p{Letter}$/u.test(char) && /^[\p{Script=Han}\p{Script=Latin}]$/u.test(char));

// Share the same alphabet with the server; NFC preserves accented Latin names
// without turning compatibility symbols or digits into acceptable letters.
export function filterUsername(value) {
  return [...String(value).normalize('NFC')].filter(allowed).slice(0, USERNAME_LIMIT).join('');
}

export function validateUsername(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC');
  if (filterUsername(normalized) !== normalized) return null;
  return normalized.trim() || null;
}

export function bindUsernameInput(input) {
  let composing = false;
  function filter() {
    const before = input.value, start = input.selectionStart, end = input.selectionEnd;
    const after = filterUsername(before);
    if (after !== before) {
      input.value = after;
      if (start !== null && end !== null) input.setSelectionRange(
        filterUsername(before.slice(0, start)).length, filterUsername(before.slice(0, end)).length);
    }
    input.setCustomValidity('');
  }
  // Leave the IME's intermediate text alone; filter once the candidate is committed.
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; filter(); });
  input.addEventListener('input', event => { if (!composing && !event.isComposing) filter(); });
  input.addEventListener('change', () => { if (!composing) filter(); });
  return {
    get composing() { return composing; },
    value() {
      if (composing) return null;
      filter();
      const username = validateUsername(input.value);
      input.setCustomValidity(username ? '' : USERNAME_ERROR);
      if (!username) input.reportValidity();
      else input.value = username;
      return username;
    },
    clear() { composing = false; input.value = ''; input.setCustomValidity(''); }
  };
}
