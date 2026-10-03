/**
 * One error shape for the whole API:
 * { "success": false, "error": { "code": "...", "message": "…", "fields": {…} } }
 * Messages are user facing Arabic; codes are stable and safe to switch on.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_PHONE'
  | 'INVALID_EMAIL'
  | 'WEAK_PASSWORD'
  | 'PHONE_ALREADY_REGISTERED'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'SESSION_REVOKED'
  | 'RECOVERY_CODE_INVALID'
  | 'FORBIDDEN'
  | 'NOT_A_MEMBER'
  | 'NOT_A_MODERATOR'
  | 'ALREADY_A_MEMBER'
  | 'JOIN_REQUEST_PENDING'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_ARCHIVED'
  | 'CONTENT_NOT_FOUND'
  | 'HOMEWORK_NOT_FOUND'
  | 'EXAM_NOT_FOUND'
  | 'EVENT_NOT_FOUND'
  | 'ISSUE_NOT_FOUND'
  | 'BOOK_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'ROOM_NOT_FOUND'
  | 'SUBJECT_NOT_FOUND'
  | 'SCHEDULE_NOT_FOUND'
  | 'SLOT_NOT_FOUND'
  | 'SLOT_ALREADY_FILLED'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ALREADY_DECIDED'
  | 'PROPOSAL_WITHDRAWN'
  | 'VOTE_NOT_ALLOWED'
  | 'DUPLICATE_REQUEST'
  | 'IDEMPOTENT_REPLAY'
  | 'CONFLICT'
  | 'REVISION_MISMATCH'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED';

const MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'بعض الحقول غير صحيحة.',
  INVALID_PHONE: 'رقم الهاتف غير صحيح. اكتبه بالصيغة 7XXXXXXXX أو +967….',
  INVALID_EMAIL: 'البريد الإلكتروني غير صحيح.',
  WEAK_PASSWORD: 'كلمة المرور قصيرة. استخدم 8 أحرف على الأقل.',
  PHONE_ALREADY_REGISTERED: 'هذا الرقم مسجّل مسبقًا.',
  EMAIL_ALREADY_REGISTERED: 'هذا البريد مستخدم في حساب آخر.',
  INVALID_CREDENTIALS: 'رقم الهاتف أو كلمة المرور غير صحيحة.',
  ACCOUNT_LOCKED: 'تم إيقاف المحاولات مؤقتًا. حاول بعد قليل.',
  ACCOUNT_SUSPENDED: 'هذا الحساب موقوف. تواصل مع مشرف المجموعة.',
  UNAUTHORIZED: 'يجب تسجيل الدخول.',
  TOKEN_EXPIRED: 'انتهت الجلسة. سجّل الدخول مرة أخرى.',
  SESSION_REVOKED: 'تم إنهاء هذه الجلسة من جهاز آخر.',
  RECOVERY_CODE_INVALID: 'رمز الاسترداد غير صحيح.',
  FORBIDDEN: 'لا تملك صلاحية هذا الإجراء.',
  NOT_A_MEMBER: 'أنت لست عضوًا في هذه المجموعة.',
  NOT_A_MODERATOR: 'هذا الإجراء لمشرف المجموعة فقط.',
  ALREADY_A_MEMBER: 'أنت عضو في هذه المجموعة بالفعل.',
  JOIN_REQUEST_PENDING: 'لديك طلب انضمام قيد المراجعة.',
  GROUP_NOT_FOUND: 'المجموعة غير موجودة.',
  GROUP_ARCHIVED: 'هذه المجموعة ضمن سنة دراسية مؤرشفة.',
  CONTENT_NOT_FOUND: 'المحتوى غير موجود.',
  HOMEWORK_NOT_FOUND: 'الواجب غير موجود.',
  EXAM_NOT_FOUND: 'الاختبار غير موجود.',
  EVENT_NOT_FOUND: 'الحدث غير موجود.',
  ISSUE_NOT_FOUND: 'الاستفسار غير موجود.',
  BOOK_NOT_FOUND: 'الكتاب غير موجود.',
  FILE_NOT_FOUND: 'الملف غير موجود.',
  ROOM_NOT_FOUND: 'المحادثة غير موجودة.',
  SUBJECT_NOT_FOUND: 'المادة غير موجودة.',
  SCHEDULE_NOT_FOUND: 'لا يوجد جدول لهذه المجموعة في هذا التاريخ.',
  SLOT_NOT_FOUND: 'الحصة غير موجودة في الجدول.',
  SLOT_ALREADY_FILLED: 'هذه الحصة فيها مادة بالفعل. أرسل اقتراح تعديل.',
  PROPOSAL_NOT_FOUND: 'الاقتراح غير موجود.',
  PROPOSAL_ALREADY_DECIDED: 'تم البت في هذا الاقتراح.',
  PROPOSAL_WITHDRAWN: 'تم سحب هذا الاقتراح.',
  VOTE_NOT_ALLOWED: 'لا تملك حق التصويت في هذه المجموعة.',
  DUPLICATE_REQUEST: 'يوجد طلب مفتوح على هذا المحتوى بالفعل.',
  IDEMPOTENT_REPLAY: 'تم تنفيذ هذا الطلب مسبقًا.',
  CONFLICT: 'حدث تعارض مع نسخة أحدث من المحتوى.',
  REVISION_MISMATCH: 'تم تعديل المحتوى من شخص آخر. حدّث الصفحة ثم أعد المحاولة.',
  RATE_LIMITED: 'محاولات كثيرة في وقت قصير. حاول بعد قليل.',
  PAYLOAD_TOO_LARGE: 'حجم الملف أكبر من الحد المسموح.',
  UNSUPPORTED_MEDIA_TYPE: 'نوع الملف غير مدعوم.',
  NOT_FOUND: 'العنصر المطلوب غير موجود.',
  METHOD_NOT_ALLOWED: 'طريقة الطلب غير مدعومة.',
  INTERNAL_ERROR: 'حدث خطأ غير متوقع. حاول مرة أخرى.',
  NOT_IMPLEMENTED: 'هذه الميزة غير متاحة بعد.',
};

const STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  INVALID_PHONE: 400,
  INVALID_EMAIL: 400,
  WEAK_PASSWORD: 400,
  PHONE_ALREADY_REGISTERED: 409,
  EMAIL_ALREADY_REGISTERED: 409,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  ACCOUNT_SUSPENDED: 403,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  SESSION_REVOKED: 401,
  RECOVERY_CODE_INVALID: 400,
  FORBIDDEN: 403,
  NOT_A_MEMBER: 403,
  NOT_A_MODERATOR: 403,
  ALREADY_A_MEMBER: 409,
  JOIN_REQUEST_PENDING: 409,
  GROUP_NOT_FOUND: 404,
  GROUP_ARCHIVED: 409,
  CONTENT_NOT_FOUND: 404,
  HOMEWORK_NOT_FOUND: 404,
  EXAM_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  ISSUE_NOT_FOUND: 404,
  BOOK_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  SUBJECT_NOT_FOUND: 404,
  SCHEDULE_NOT_FOUND: 404,
  SLOT_NOT_FOUND: 404,
  SLOT_ALREADY_FILLED: 409,
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_ALREADY_DECIDED: 409,
  PROPOSAL_WITHDRAWN: 409,
  VOTE_NOT_ALLOWED: 403,
  DUPLICATE_REQUEST: 409,
  IDEMPOTENT_REPLAY: 409,
  CONFLICT: 409,
  REVISION_MISMATCH: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: Record<string, string>;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, options?: { status?: number; fields?: Record<string, string>; details?: unknown }) {
    super(message ?? MESSAGES[code] ?? MESSAGES.INTERNAL_ERROR);
    this.name = 'ApiError';
    this.code = code;
    this.status = options?.status ?? STATUS[code] ?? 400;
    if (options?.fields) this.fields = options.fields;
    if (options?.details !== undefined) this.details = options.details;
  }

  toJSON() {
    return {
      success: false as const,
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (message?: string, fields?: Record<string, string>) =>
  new ApiError('VALIDATION_ERROR', message, fields ? { fields } : undefined);
export const unauthorized = (code: ErrorCode = 'UNAUTHORIZED', message?: string) => new ApiError(code, message);
export const forbidden = (code: ErrorCode = 'FORBIDDEN', message?: string) => new ApiError(code, message);
export const notFound = (code: ErrorCode = 'NOT_FOUND', message?: string) => new ApiError(code, message);
export const conflict = (code: ErrorCode = 'CONFLICT', message?: string) => new ApiError(code, message);
export const rateLimited = (message?: string) => new ApiError('RATE_LIMITED', message);
export const internal = (message?: string, details?: unknown) =>
  new ApiError('INTERNAL_ERROR', message, details !== undefined ? { details } : undefined);

export function messageFor(code: ErrorCode): string {
  return MESSAGES[code] ?? MESSAGES.INTERNAL_ERROR;
}
