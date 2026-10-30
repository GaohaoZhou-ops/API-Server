// Browser persistence is renewed on each session check; server sessions live in memory.
export const COOKIE_AGE = 400 * 24 * 60 * 60;

export function cookieValue(req, name) {
  const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}

export function appendCookie(res, value) {
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), value]);
}
