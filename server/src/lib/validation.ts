/**
 * A tiny dependency-free validator.
 *
 * The Android client is not a trusted source (§98), so every request body is
 * checked here before it reaches the database, and the errors come back in the
 * shape the app can show field by field.
 */
import { ApiError } from './errors';
import { isIsoDate, isIsoMonth, isClockTime } from './date';

export type FieldErrors = Record<string, string>;
export type Fields = Record<string, unknown>;

export interface Schema<T> {
  parse(value: unknown, path: string, errors: FieldErrors): T | undefined;
}

export class ValidationException extends ApiError {
  constructor(fields: FieldErrors) {
    super('VALIDATION_ERROR', undefined, { fields });
  }
}

function fail(errors: FieldErrors, path: string, message: string): undefined {
  if (!(path in errors)) errors[path] = message;
  return undefined;
}

// ── primitives ───────────────────────────────────────────────────────────────

export function string(options: { min?: number; max?: number; trim?: boolean; pattern?: RegExp; patternMessage?: string; allowEmpty?: boolean } = {}): Schema<string> {
  const { min = 1, max = 4000, trim = true, pattern, patternMessage, allowEmpty = false } = options;
  return {
    parse(value, path, errors) {
      if (typeof value !== 'string') return fail(errors, path, 'يجب أن يكون نصًا.');
      const text = trim ? value.trim() : value;
      if (text.length === 0 && !allowEmpty) return fail(errors, path, 'هذا الحقل مطلوب.');
      if (text.length < min && !(allowEmpty && text.length === 0)) return fail(errors, path, `أقصر من الحد المسموح (${min}).`);
      if (text.length > max) return fail(errors, path, `أطول من الحد المسموح (${max}).`);
      if (pattern && !pattern.test(text)) return fail(errors, path, patternMessage ?? 'صيغة غير صحيحة.');
      return text;
    },
  };
}

export function optional<T>(schema: Schema<T>): Schema<T | undefined> {
  return {
    parse(value, path, errors) {
      if (value === undefined || value === null || value === '') return undefined;
      return schema.parse(value, path, errors);
    },
  };
}

export function withDefault<T>(schema: Schema<T>, fallback: T): Schema<T> {
  return {
    parse(value, path, errors) {
      if (value === undefined || value === null || value === '') return fallback;
      return schema.parse(value, path, errors) ?? fallback;
    },
  };
}

export function number(options: { min?: number; max?: number; integer?: boolean } = {}): Schema<number> {
  const { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, integer = true } = options;
  return {
    parse(value, path, errors) {
      const parsed = typeof value === 'string' ? Number(value) : value;
      if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fail(errors, path, 'يجب أن يكون رقمًا.');
      if (integer && !Number.isInteger(parsed)) return fail(errors, path, 'يجب أن يكون عددًا صحيحًا.');
      if (parsed < min || parsed > max) return fail(errors, path, `القيمة خارج النطاق المسموح (${min}..${max}).`);
      return parsed;
    },
  };
}

export function boolean(): Schema<boolean> {
  return {
    parse(value, path, errors) {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === '1' || value === 'true') return true;
      if (value === 0 || value === '0' || value === 'false') return false;
      return fail(errors, path, 'يجب أن يكون صحيحًا أو خطأً.');
    },
  };
}

export function oneOf<T extends string>(values: readonly T[], message?: string): Schema<T> {
  return {
    parse(value, path, errors) {
      if (typeof value !== 'string' || !values.includes(value as T)) {
        return fail(errors, path, message ?? `القيمة يجب أن تكون إحدى: ${values.join(', ')}.`);
      }
      return value as T;
    },
  };
}

export function arrayOf<T>(schema: Schema<T>, options: { min?: number; max?: number } = {}): Schema<T[]> {
  const { min = 0, max = 100 } = options;
  return {
    parse(value, path, errors) {
      if (!Array.isArray(value)) return fail(errors, path, 'يجب أن تكون قائمة.');
      if (value.length < min) return fail(errors, path, `يجب أن تحتوي على ${min} عنصر على الأقل.`);
      if (value.length > max) return fail(errors, path, `الحد الأقصى ${max} عنصر.`);
      const out: T[] = [];
      value.forEach((item, index) => {
        const parsed = schema.parse(item, `${path}[${index}]`, errors);
        if (parsed !== undefined) out.push(parsed);
      });
      return out;
    },
  };
}

/** Allows an explicit null (means "كل الشعب" for sectionScope). */
export function unionNull<T>(schema: Schema<T>): Schema<T | null> {
  return {
    parse(value, path, errors) {
      if (value === null) return null;
      return schema.parse(value, path, errors);
    },
  };
}

export function literalNull(): Schema<null> {
  return {
    parse(value, path, errors) {
      if (value === null || value === undefined) return null;
      return fail(errors, path, 'يجب أن تكون القيمة فارغة.');
    },
  };
}

// ── domain specific ──────────────────────────────────────────────────────────

const ARABIC_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** Accepts 7XXXXXXXX, 07XXXXXXXX, +967…, 00967…, with spaces/dashes/Arabic digits. */
export function normalizePhone(raw: string): string | null {
  let text = '';
  for (const char of raw) {
    if (ARABIC_DIGITS[char]) text += ARABIC_DIGITS[char];
    else if (/[0-9+]/.test(char)) text += char;
  }
  if (text.startsWith('00')) text = text.slice(2);
  if (text.startsWith('+')) text = text.slice(1);
  if (text.startsWith('967')) text = text.slice(3);
  text = text.replace(/^0+/, '');
  if (!/^7[01378]\d{7}$/.test(text)) return null;
  return `+967${text}`;
}

export const phone = (): Schema<string> => ({
  parse(value, path, errors) {
    if (typeof value !== 'string' || value.trim().length === 0) return fail(errors, path, 'رقم الهاتف مطلوب.');
    const normalized = normalizePhone(value);
    if (!normalized) return fail(errors, path, 'رقم الهاتف غير صحيح. اكتبه بالصيغة 7XXXXXXXX.');
    return normalized;
  },
});

export const email = (): Schema<string> => ({
  parse(value, path, errors) {
    if (typeof value !== 'string') return fail(errors, path, 'البريد الإلكتروني غير صحيح.');
    const text = value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(text) || text.length > 254) {
      return fail(errors, path, 'البريد الإلكتروني غير صحيح.');
    }
    return text;
  },
});

export const httpUrl = (): Schema<string> => ({
  parse(value, path, errors) {
    if (typeof value !== 'string') return fail(errors, path, 'الرابط غير صحيح.');
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail(errors, path, 'الرابط يجب أن يبدأ بـ http أو https.');
      if (url.toString().length > 2048) return fail(errors, path, 'الرابط طويل جدًا.');
      return url.toString();
    } catch {
      return fail(errors, path, 'الرابط غير صحيح.');
    }
  },
});

export const isoDate = (): Schema<string> => ({
  parse(value, path, errors) {
    if (!isIsoDate(value)) return fail(errors, path, 'التاريخ يجب أن يكون بالصيغة YYYY-MM-DD.');
    return value;
  },
});

export const isoMonth = (): Schema<string> => ({
  parse(value, path, errors) {
    if (!isIsoMonth(value)) return fail(errors, path, 'الشهر يجب أن يكون بالصيغة YYYY-MM.');
    return value;
  },
});

export const clockTime = (): Schema<string> => ({
  parse(value, path, errors) {
    if (!isClockTime(value)) return fail(errors, path, 'الوقت يجب أن يكون بالصيغة HH:MM.');
    return value;
  },
});

export const sectionCode = (): Schema<string> => ({
  parse(value, path, errors) {
    if (typeof value !== 'string' || !/^[A-D]$/.test(value)) return fail(errors, path, 'الشعبة غير صحيحة.');
    return value;
  },
});

export const authKey = (): Schema<string> => ({
  parse(value, path, errors) {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
      return fail(errors, path, 'مفتاح كلمة المرور غير صحيح.');
    }
    return value.toLowerCase();
  },
});

export const cuid = (): Schema<string> => ({
  parse(value, path, errors) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(value)) {
      return fail(errors, path, 'المعرّف غير صحيح.');
    }
    return value;
  },
});

export const passwordPlainCheck = (): Schema<string> => ({
  parse(value, path, errors) {
    if (typeof value !== 'string') return fail(errors, path, 'كلمة المرور مطلوبة.');
    if (value.length < 8) return fail(errors, path, 'كلمة المرور قصيرة. استخدم 8 أحرف على الأقل.');
    if (value.length > 200) return fail(errors, path, 'كلمة المرور طويلة جدًا.');
    return value;
  },
});

// ── object schema ────────────────────────────────────────────────────────────

type InferObject<S extends Fields> = {
  [K in keyof S]: S[K] extends Schema<infer T> ? T : never;
};

export function object<S extends Fields>(spec: S): Schema<InferObject<S>> {
  return {
    parse(value, path, errors) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(errors, path || 'body', 'صيغة الطلب غير صحيحة.');
      }
      const source = value as Fields;
      const result: Fields = {};
      for (const key of Object.keys(spec)) {
        const schema = spec[key] as Schema<unknown>;
        const parsed = schema.parse(source[key], key, errors);
        if (parsed !== undefined) result[key] = parsed;
      }
      return result as InferObject<S>;
    },
  };
}

/** Parse a body and throw a 400 with field level errors when it is not valid. */
export function parseOrThrow<T>(schema: Schema<T>, value: unknown, path = ''): T {
  const errors: FieldErrors = {};
  const parsed = schema.parse(value, path, errors);
  if (parsed === undefined || Object.keys(errors).length > 0) {
    throw new ValidationException(errors);
  }
  return parsed;
}

export type { InferObject };
