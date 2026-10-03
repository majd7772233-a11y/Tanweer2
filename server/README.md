# خادم تنوير

خادم [تنوير](https://tanweer.magd.workers.dev) على Cloudflare Workers: D1 للبيانات المنظَّمة، R2 للملفات، Durable Objects للدردشة الحيّة. كل التنفيذ داخل هذا المجلد، والنشر يقوم به مشرف النظام وفق `docs/OPERATIONS.md`.

## تشغيل سريع

```bash
cd server
npm ci --legacy-peer-deps      # .npmrc يثبّت legacy-peer-deps
npm run typecheck              # tsc --noEmit
npm test                       # vitest داخل workerd مع D1 حقيقية وترحيلات حقيقية
npm run dev                    # wrangler dev على http://127.0.0.1:8787
```

الأسرار محليًا في `.dev.vars` (انسخ `.dev.vars.example`):

```
PASSWORD_PEPPER="…"
SESSION_PEPPER="…"
FILE_SIGNING_SECRET="…"
```

## الأوامر

| الأمر | الوظيفة |
| --- | --- |
| `npm run dev` | تشغيل محلي |
| `npm test` / `npm run test:watch` | الاختبارات |
| `npm run typecheck` | فحص الأنواع |
| `npm run db:migrate:local` | تطبيق الترحيلات محليًا |
| `npm run db:migrate:remote` | تطبيق الترحيلات على D1 الحقيقية |
| `npm run db:migrations:list` | عرض حالة الترحيلات |
| `npm run deploy` | نشر Worker |

لا يوجد سكربت lint مستقل: `npm run typecheck` هو فحص CI (لا نضيف أدوات لا تُشغَّل في CI).

## بنية المجلد

```
src/
  index.ts          دخول Worker: CORS · /ws · /api/v1 · صفحة ترحيب · cron التنظيف
  router.ts         جدول المسارات وسلسلة الوسائط
  env.ts            كل الربطات والأسرار والإعدادات في مكان واحد
  lib/              أدوات مشتركة: ids, crypto, date, validation, response, context, errors, audit
  middleware/       auth, rateLimit, permissions, idempotency
  db/
    migrations/     0001 … 0009 (0009 يزرع هيكل المدرسة فقط: صفوف، شعب، مواد، مجموعات، جداول فارغة)
    queries/        17 وحدة استعلام (SQL فقط)
  services/         20 خدمة (قواعد العمل)
  realtime/         GroupChatDO + entry.ts (بوابة WebSocket)
  storage/r2.ts     R2: مفاتيح، قراءة، كتابة، حذف
tests/              smoke · auth · groups · schedule · content · issues
```

## الاختبارات

الاختبارات تعمل ضد Worker حقيقي وD1 حقيقية تُنشأ بالترحيلات نفسها عبر `@cloudflare/vitest-pool-workers`، والملفات: `smoke`, `auth`, `groups`, `schedule`, `content`, `issues` (٤٥ اختبارًا).

الأدوات المشتركة في `tests/helpers.ts`: `api` / `expectOk` / `expectError` حول `SELF.fetch`، توليد `authKey` بنفس اشتقاق التطبيق، `registerAccount` (يُنشئ حسابًا حقيقيًا ويعيد الرموز ومجموعة الصف)، `uploadFile` (ينفّذ مسار الرفع الموقّع كاملًا)، و`cleanMutableData` التي تُفرغ ما كتبه الاختبار وتُبقي هيكل المدرسة المزروع.

قاعدتان مهمتان عند إضافة اختبار:

1. لا تحذف صفوف `group_sections` أو المجموعات من نوع `CLASS` — عليها يعتمد تسجيل الطلاب.
2. شعب كل صف كما في الواقع: ٧ (أ)، ٨–٩ (أ، ب)، ١٠–١١ (أ، ب، ج، د)، ١٢ (أ، ب، ج).

## العقد

- كل المسارات تحت `/api/v1/`.
- نجاح: `{ success: true, data, meta? }` — خطأ: `{ success: false, error: { code, message, fields? } }`.
- التوقيت UTC بصيغة ISO-8601، والتواريخ الدراسية `YYYY-MM-DD` بتوقيت `Asia/Aden`.
- الملفات: `POST /files/upload-intent` ثم `PUT` إلى الرابط الموقّع ثم `POST /files/complete`؛ والقراءة من `GET /files/:id/content`.
- الدردشة: `wss://tanweer.magd.workers.dev/ws?token=<accessToken>` (أو `Authorization`، أو `sec-websocket-protocol: tanweer.<token>`).

## وثائق

- `docs/ARCHITECTURE.md` — طبقات الخادم، أماكن البيانات، دورة حياة المحتوى، حدود Cloudflare.
- `docs/GOVERNANCE.md` — قواعد المجتمع: الإزالة بالإجماع، التصحيح بالأغلبية، الجدول بالربع.
- `docs/OPERATIONS.md` — النشر، فتح سنة دراسية، النسخ الاحتياطي، الحوادث.
- `docs/SECURITY.md` — كلمة المرور، الجلسات، الصلاحيات، الأسرار.

## سياسة المشروع

لا بيانات تجريبية ولا روبوتات ولا قوالب وهمية: الترحيل `0009` يزرع هيكل المدرسة فقط، وأول محتوى في التطبيق يكتبه طالب حقيقي.
