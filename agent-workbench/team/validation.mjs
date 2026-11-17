import { AppError } from '../src/net.mjs';
export const fail = (message, status = 400) => {
  throw new AppError(message, status);
};
export function label(s, max = 80) {
  if (typeof s !== 'string' || !s.trim() || s.length > max || /[\x00-\x1f\x7f]/.test(s))
    fail('名称格式不正确');
  return s.trim();
}
