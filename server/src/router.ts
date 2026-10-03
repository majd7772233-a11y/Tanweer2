/**
 * The route table. `index.ts` stays tiny, business logic stays in services
 * (§91, §92).
 *
 * Route shape: METHOD /api/v1/<resource>/:param/…
 * Every handler returns a ready `Response`; the helpers in lib/response.ts build
 * the standard { success, data, meta } envelope.
 */
import type { Ctx, Handler, Middleware } from './lib/context';
import { ApiError } from './lib/errors';
import { methodNotAllowedResponse, notFoundResponse, ok, created } from './lib/response';
import { auth, optionalAuth } from './middleware/auth';
import { POLICIES, rateLimit } from './middleware/rateLimit';
import { idempotent } from './middleware/idempotency';

import * as authService from './services/auth';
import * as userService from './services/users';
import * as groupService from './services/groups';
import * as scheduleService from './services/schedule';
import * as calendarService from './services/calendar';
import * as contentService from './services/content';
import * as homeworkService from './services/homework';
import * as examService from './services/exams';
import * as eventService from './services/events';
import * as issueService from './services/issues';
import * as votingService from './services/voting';
import * as notificationService from './services/notifications';
import * as bookService from './services/books';
import * as fileService from './services/files';
import * as noteService from './services/notes';
import * as searchService from './services/search';
import * as syncService from './services/sync';
import * as chatService from './services/chat';
import { loadSchoolStructure } from './db/queries/structure';

interface Route {
  method: string;
  segments: string[];
  middlewares: Middleware[];
  handler: Handler;
}

/** Wraps a service call so plain objects become { success: true, data }. */
function respond<A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<unknown> | unknown, ...args: A): Handler {
  return async (ctx) => {
    const result = await fn(ctx, ...args);
    if (result instanceof Response) return result;
    return ok(result);
  };
}

function respondCreated<A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<unknown> | unknown, ...args: A): Handler {
  return async (ctx) => {
    const result = await fn(ctx, ...args);
    if (result instanceof Response) return result;
    return created(result);
  };
}

const noop: Middleware = async (_ctx, next) => next();
const write = rateLimit(POLICIES.write.bucket, POLICIES.write.limit, POLICIES.write.windowSeconds, { by: 'user' });

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, middlewares: Middleware[], handler: Handler): void {
    this.routes.push({ method, segments: splitPath(path), middlewares, handler });
  }

  get(path: string, handler: Handler, options: { auth?: boolean; middleware?: Middleware[] } = {}): void {
    this.add('GET', path, [authMiddleware(options), ...(options.middleware ?? [])], handler);
  }

  post(path: string, handler: Handler, options: { auth?: boolean; middleware?: Middleware[] } = {}): void {
    this.add('POST', path, [authMiddleware(options), ...(options.middleware ?? [])], handler);
  }

  patch(path: string, handler: Handler, options: { auth?: boolean; middleware?: Middleware[] } = {}): void {
    this.add('PATCH', path, [authMiddleware(options), ...(options.middleware ?? [])], handler);
  }

  put(path: string, handler: Handler, options: { auth?: boolean; middleware?: Middleware[] } = {}): void {
    this.add('PUT', path, [authMiddleware(options), ...(options.middleware ?? [])], handler);
  }

  delete(path: string, handler: Handler, options: { auth?: boolean; middleware?: Middleware[] } = {}): void {
    this.add('DELETE', path, [authMiddleware(options), ...(options.middleware ?? [])], handler);
  }

  async handle(ctx: Ctx): Promise<Response> {
    const path = ctx.url.pathname;
    const segments = splitPath(path);
    let pathMatched = false;

    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== ctx.req.method) continue;

      for (const [key, value] of Object.entries(params)) ctx.params[key] = value;

      // Middlewares run outside-in; the handler is the innermost step.
      let index = -1;
      const dispatch = async (position: number): Promise<Response> => {
        if (position <= index) throw new ApiError('INTERNAL_ERROR', 'سلسلة الوسائط غير صحيحة.');
        index = position;
        const middleware = route.middlewares[position];
        if (!middleware) return route.handler(ctx);
        return middleware(ctx, () => dispatch(position + 1));
      };

      return dispatch(0);
    }

    if (pathMatched) return methodNotAllowedResponse(ctx.req.method, path);
    return notFoundResponse(path);
  }
}

function authMiddleware(options: { auth?: boolean }): Middleware {
  if (options.auth === false) return noop;
  return auth;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const value = actual[index] as string;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (expected !== value) return null;
  }
  return params;
}

/** Registers the entity actions that lessons, homeworks, exams and events share. */
function registerEntityRoutes(router: Router, base: string, entityType: 'CONTENT' | 'HOMEWORK' | 'EXAM' | 'EVENT' | 'ISSUE'): void {
  router.get(`${base}/:id/comments`, async (ctx) => {
    const { listComments } = await import('./db/queries/content');
    const { commentDto } = await import('./services/dto');
    const rows = await listComments(ctx.env.TANWEER_DB, entityType, ctx.param('id'), 200);
    return ok(rows.map(commentDto));
  });

  router.post(`${base}/:id/comments`, async (ctx) => {
    const result = await contentService.addComment(ctx, entityType, ctx.param('id'));
    return created(result);
  }, { middleware: [write, rateLimit(POLICIES.comment.bucket, POLICIES.comment.limit, POLICIES.comment.windowSeconds, { by: 'user' })] });

  router.post(`${base}/:id/useful`, async (ctx) => ok(await contentService.toggleUseful(ctx, entityType, ctx.param('id'))), {
    middleware: [rateLimit(POLICIES.vote.bucket, POLICIES.vote.limit, POLICIES.vote.windowSeconds, { by: 'user' })],
  });

  router.post(`${base}/:id/save`, async (ctx) => ok(await contentService.toggleSaved(ctx, entityType, ctx.param('id'))));

  router.post(`${base}/:id/corrections`, async (ctx) => created(await contentService.requestCorrection(ctx, entityType, ctx.param('id'))), {
    middleware: [write],
  });

  router.post(`${base}/:id/deletion-requests`, async (ctx) => created(await contentService.requestDeletion(ctx, entityType, ctx.param('id'))), {
    middleware: [write],
  });

  router.post(`${base}/:id/questions`, async (ctx) => created(await issueService.quickQuestion(ctx, entityType, ctx.param('id'))), {
    middleware: [write, rateLimit(POLICIES.issue.bucket, POLICIES.issue.limit, POLICIES.issue.windowSeconds, { by: 'user' })],
  });
}

export function buildRouter(): Router {
  const router = new Router();
  const v1 = '/api/v1';

  // ── health ────────────────────────────────────────────────────────────────
  router.get('/health', async (ctx) => {
    const started = Date.now();
    const row = await ctx.env.TANWEER_DB.prepare('SELECT COUNT(*) AS n FROM grades').first<{ n: number }>();
    return ok({
      status: 'ok',
      app: 'تنوير',
      environment: ctx.env.APP_ENV ?? 'unknown',
      database: row ? 'reachable' : 'unknown',
      timezone: ctx.timeZone,
      today: ctx.today,
      latencyMs: Date.now() - started,
      version: '1.0.0',
    });
  }, { auth: false });

  // ── auth ──────────────────────────────────────────────────────────────────
  router.post(
    `${v1}/auth/kdf-params`,
    async (ctx) => {
      const body = await ctx.json<{ phone?: string }>();
      const raw = String(body.phone ?? ctx.query.get('phone') ?? '');
      return ok(await authService.kdfParams(ctx, raw));
    },
    { auth: false, middleware: [rateLimit(POLICIES.kdf.bucket, POLICIES.kdf.limit, POLICIES.kdf.windowSeconds, { by: 'ip' })] },
  );
  router.post(`${v1}/auth/register`, respondCreated((ctx) => authService.register(ctx)), {
    auth: false,
    middleware: [rateLimit(POLICIES.register.bucket, POLICIES.register.limit, POLICIES.register.windowSeconds, { by: 'ip' }), idempotent('auth.register')],
  });
  router.post(`${v1}/auth/login`, respond((ctx) => authService.login(ctx)), {
    auth: false,
    middleware: [rateLimit(POLICIES.login.bucket, POLICIES.login.limit, POLICIES.login.windowSeconds, { by: 'ip' })],
  });
  router.post(`${v1}/auth/refresh`, respond((ctx) => authService.refresh(ctx)), {
    auth: false,
    middleware: [rateLimit(POLICIES.refresh.bucket, POLICIES.refresh.limit, POLICIES.refresh.windowSeconds, { by: 'ip' })],
  });
  router.post(`${v1}/auth/logout`, respond((ctx) => authService.logout(ctx)));
  router.post(`${v1}/auth/password/change`, respond((ctx) => authService.changePassword(ctx)), { middleware: [write] });
  router.post(`${v1}/auth/recovery/reset`, respond((ctx) => authService.resetWithRecovery(ctx)), {
    auth: false,
    middleware: [rateLimit(POLICIES.recovery.bucket, POLICIES.recovery.limit, POLICIES.recovery.windowSeconds, { by: 'ip' })],
  });

  // ── me ────────────────────────────────────────────────────────────────────
  router.get(`${v1}/me`, respond((ctx) => userService.me(ctx)));
  router.patch(`${v1}/me`, respond((ctx) => userService.updateProfile(ctx)), { middleware: [write] });
  router.get(`${v1}/me/devices`, respond((ctx) => userService.myDevices(ctx)));
  router.delete(`${v1}/me/devices/:deviceId`, respond((ctx) => userService.revokeDeviceById(ctx, ctx.param('deviceId'))));
  router.post(`${v1}/me/push-token`, respond((ctx) => userService.savePushToken(ctx)), { middleware: [write] });
  router.get(`${v1}/me/contributions`, respond((ctx) => userService.myContributions(ctx)));
  router.get(`${v1}/me/missed`, respond((ctx) => userService.missedSinceLastVisit(ctx)));
  router.get(`${v1}/me/widget`, respond((ctx) => userService.widgetSummary(ctx, ctx.q('groupId') ?? '')), { middleware: [optionalAuth] });
  router.get(`${v1}/users/:id`, respond((ctx) => userService.publicProfile(ctx, ctx.param('id'))));

  // ── school structure ──────────────────────────────────────────────────────
  router.get(`${v1}/school/structure`, async (ctx) => {
    const gradeId = ctx.qInt('gradeId');
    const structure = await loadSchoolStructure(ctx.env.TANWEER_DB, gradeId);
    return ok({
      academicYear: structure.academicYear,
      grades: structure.grades.map((grade) => ({ id: grade.id, name: grade.name, stage: grade.stage })),
      sections: structure.sections.map((section) => ({ id: section.id, gradeId: section.grade_id, code: section.code, label: section.label })),
      subjects: structure.subjects.map((subject) => ({
        id: subject.id,
        name: subject.name,
        shortName: subject.short_name,
        emoji: subject.emoji,
        color: subject.color,
      })),
      today: ctx.today,
    });
  }, { auth: false });

  // ── groups ────────────────────────────────────────────────────────────────
  router.get(`${v1}/groups`, respond((ctx) => groupService.myGroups(ctx)));
  router.get(`${v1}/groups/discover`, respond((ctx) => groupService.discoverGroups(ctx)));
  router.post(`${v1}/groups`, respondCreated((ctx) => groupService.createGroup(ctx)), { middleware: [write, idempotent('groups.create')] });
  router.get(`${v1}/groups/:groupId`, respond((ctx) => groupService.groupDetails(ctx, ctx.param('groupId'))));
  router.get(`${v1}/groups/:groupId/members`, respond((ctx) => groupService.groupMembers(ctx, ctx.param('groupId'))));
  router.patch(`${v1}/groups/:groupId/members/:userId`, respond((ctx) => groupService.updateMember(ctx, ctx.param('groupId'), ctx.param('userId'))), { middleware: [write] });
  router.post(`${v1}/groups/:groupId/join-request`, respond((ctx) => groupService.requestToJoin(ctx, ctx.param('groupId'))), {
    middleware: [rateLimit(POLICIES.joinRequest.bucket, POLICIES.joinRequest.limit, POLICIES.joinRequest.windowSeconds, { by: 'user' }), write],
  });
  router.get(`${v1}/groups/:groupId/join-requests`, respond((ctx) => groupService.joinRequests(ctx, ctx.param('groupId'))));
  router.post(`${v1}/groups/:groupId/join-requests/:requestId/decide`, respond((ctx) => groupService.decideJoinRequestById(ctx, ctx.param('groupId'), ctx.param('requestId'))), {
    middleware: [write],
  });
  router.post(`${v1}/groups/:groupId/leave`, respond((ctx) => groupService.leaveGroup(ctx, ctx.param('groupId'))));
  router.get(`${v1}/groups/:groupId/voters`, respond((ctx) => groupService.voters(ctx, ctx.param('groupId'))));
  router.get(`${v1}/class-group`, respond((ctx) => groupService.classGroupFor(ctx, ctx.qInt('gradeId') ?? 0, ctx.q('sectionCode') ?? '')));

  // ── schedule ──────────────────────────────────────────────────────────────
  router.get(`${v1}/schedule`, respond((ctx) => scheduleService.getSchedule(ctx)));
  router.get(`${v1}/schedule/versions`, respond((ctx) => scheduleService.scheduleVersionsFor(ctx, ctx.q('groupId') ?? '')));
  router.post(`${v1}/schedule/versions`, respond((ctx) => scheduleService.createVersion(ctx)), { middleware: [write] });
  router.post(`${v1}/schedule/slots`, respond((ctx) => scheduleService.fillPeriod(ctx)), { middleware: [write, idempotent('schedule.fill')] });
  router.get(`${v1}/schedule/proposals`, respond((ctx) => scheduleService.listProposalsForGroup(ctx, ctx.q('groupId') ?? '')));
  router.post(`${v1}/schedule/proposals`, respond((ctx) => scheduleService.proposeChange(ctx)), { middleware: [write, idempotent('schedule.propose')] });
  router.get(`${v1}/schedule/proposals/:proposalId`, respond((ctx) => scheduleService.proposalDetail(ctx, ctx.param('proposalId'))));
  router.post(`${v1}/schedule/proposals/:proposalId/withdraw`, respond((ctx) => scheduleService.withdrawProposal(ctx, ctx.param('proposalId'))));

  // ── calendar ──────────────────────────────────────────────────────────────
  router.get(`${v1}/calendar`, respond((ctx) => calendarService.month(ctx)));
  router.get(`${v1}/day/:date`, respond((ctx) => calendarService.dayPage(ctx)));
  router.get(`${v1}/today`, respond((ctx) => calendarService.today(ctx)));
  router.get(`${v1}/tomorrow`, respond((ctx) => calendarService.nextDay(ctx)));
  router.get(`${v1}/yesterday`, respond((ctx) => calendarService.previousDay(ctx)));
  router.get(`${v1}/year-map`, respond((ctx) => calendarService.yearMap(ctx)));
  router.get(`${v1}/subjects/:subjectId/journey`, respond((ctx) => calendarService.subjectJourney(ctx)));
  router.get(`${v1}/widget/summary`, respond((ctx) => userService.widgetSummary(ctx, ctx.q('groupId') ?? '')));

  // ── content ───────────────────────────────────────────────────────────────
  router.get(`${v1}/content`, respond((ctx) => contentService.listContentForGroup(ctx)));
  router.post(`${v1}/content`, respondCreated((ctx) => contentService.createContent(ctx)), { middleware: [write, idempotent('content.create')] });
  router.get(`${v1}/content/:id`, respond((ctx) => contentService.contentDetail(ctx, ctx.param('id'))));
  router.patch(`${v1}/content/:id`, respond((ctx) => contentService.updateContent(ctx, ctx.param('id'))), { middleware: [write] });
  router.post(`${v1}/content/:id/media`, respond((ctx) => contentService.addMediaToContent(ctx, ctx.param('id'))), {
    middleware: [write, idempotent('content.media')],
  });
  router.post(`${v1}/content/:id/merge`, respond((ctx) => contentService.mergeContents(ctx, ctx.param('id'))), { middleware: [write] });

  // ── homeworks ─────────────────────────────────────────────────────────────
  router.get(`${v1}/homeworks`, respond((ctx) => homeworkService.listForScope(ctx)));
  router.get(`${v1}/homeworks/summary`, respond((ctx) => homeworkService.summary(ctx)));
  router.post(`${v1}/homeworks`, respondCreated((ctx) => homeworkService.createHomework(ctx)), { middleware: [write, idempotent('homework.create')] });
  router.get(`${v1}/homeworks/:id`, respond((ctx) => homeworkService.homeworkDetail(ctx, ctx.param('id'))));
  router.patch(`${v1}/homeworks/:id`, respond((ctx) => homeworkService.updateHomeworkById(ctx, ctx.param('id'))), { middleware: [write] });
  router.post(`${v1}/homeworks/:id/complete`, respond((ctx) => homeworkService.markCompletion(ctx, ctx.param('id'))), { middleware: [write] });

  // ── exams ─────────────────────────────────────────────────────────────────
  router.get(`${v1}/exams`, respond((ctx) => examService.list(ctx)));
  router.post(`${v1}/exams`, respondCreated((ctx) => examService.createExam(ctx)), { middleware: [write, idempotent('exam.create')] });
  router.get(`${v1}/exams/:id`, respond((ctx) => examService.detail(ctx, ctx.param('id'))));
  router.patch(`${v1}/exams/:id`, respond((ctx) => examService.update(ctx, ctx.param('id'))), { middleware: [write] });

  // ── events ────────────────────────────────────────────────────────────────
  router.get(`${v1}/events`, respond((ctx) => eventService.list(ctx)));
  router.post(`${v1}/events`, respondCreated((ctx) => eventService.createEvent(ctx)), { middleware: [write, idempotent('event.create')] });
  router.get(`${v1}/events/:id`, respond((ctx) => eventService.detail(ctx, ctx.param('id'))));
  router.patch(`${v1}/events/:id`, respond((ctx) => eventService.update(ctx, ctx.param('id'))), { middleware: [write] });

  // ── issues ────────────────────────────────────────────────────────────────
  router.get(`${v1}/issues`, respond((ctx) => issueService.list(ctx)));
  router.post(`${v1}/issues`, respondCreated((ctx) => issueService.create(ctx)), {
    middleware: [write, rateLimit(POLICIES.issue.bucket, POLICIES.issue.limit, POLICIES.issue.windowSeconds, { by: 'user' }), idempotent('issue.create')],
  });
  router.get(`${v1}/issues/:issueId`, respond((ctx) => issueService.detail(ctx, ctx.param('issueId'))));
  router.patch(`${v1}/issues/:issueId/status`, respond((ctx) => issueService.setStatus(ctx, ctx.param('issueId'))), { middleware: [write] });
  router.post(`${v1}/issues/:issueId/best-answer`, respond((ctx) => issueService.bestAnswer(ctx, ctx.param('issueId'))), { middleware: [write] });
  router.post(`${v1}/issues/:issueId/comments`, respondCreated((ctx) => issueService.comment(ctx, ctx.param('issueId'))), { middleware: [write] });
  router.post(`${v1}/issues/:issueId/comments/:commentId/hide`, respond((ctx) => issueService.hideComment(ctx, ctx.param('issueId'), ctx.param('commentId'))), {
    middleware: [write],
  });

  // shared entity actions
  registerEntityRoutes(router, `${v1}/content`, 'CONTENT');
  registerEntityRoutes(router, `${v1}/homeworks`, 'HOMEWORK');
  registerEntityRoutes(router, `${v1}/exams`, 'EXAM');
  registerEntityRoutes(router, `${v1}/events`, 'EVENT');
  registerEntityRoutes(router, `${v1}/issues`, 'ISSUE');

  // ── community decisions ───────────────────────────────────────────────────
  router.post(`${v1}/votes`, respond((ctx) => votingService.castVote(ctx)), {
    middleware: [rateLimit(POLICIES.vote.bucket, POLICIES.vote.limit, POLICIES.vote.windowSeconds, { by: 'user' }), write],
  });
  router.get(`${v1}/community/requests`, respond((ctx) => votingService.openRequests(ctx, ctx.q('groupId') ?? '')));
  router.get(`${v1}/community/my-requests`, respond((ctx) => votingService.myOpenRequests(ctx)));
  router.post(`${v1}/community/deletions/:requestId/withdraw`, respond((ctx) => votingService.withdrawRequest(ctx, ctx.param('requestId'), 'DELETION')));
  router.post(`${v1}/community/corrections/:requestId/withdraw`, respond((ctx) => votingService.withdrawRequest(ctx, ctx.param('requestId'), 'CORRECTION')));

  // ── files ─────────────────────────────────────────────────────────────────
  router.post(`${v1}/files/upload-intent`, respond((ctx) => fileService.uploadIntent(ctx)), {
    middleware: [rateLimit(POLICIES.upload.bucket, POLICIES.upload.limit, POLICIES.upload.windowSeconds, { by: 'user' })],
  });
  router.put(`${v1}/files/upload/:fileId`, respond((ctx) => fileService.receiveUpload(ctx)), { auth: false });
  router.post(`${v1}/files/complete`, respond((ctx) => fileService.completeUpload(ctx)));
  router.get(`${v1}/files/:fileId/content`, respond((ctx) => fileService.serveFile(ctx)), { middleware: [optionalAuth] });
  router.get(`${v1}/files/:fileId`, respond((ctx) => fileService.fileMeta(ctx, ctx.param('fileId'))));
  router.delete(`${v1}/files/:fileId`, respond((ctx) => fileService.deleteFile(ctx, ctx.param('fileId'))));

  // ── library ───────────────────────────────────────────────────────────────
  router.get(`${v1}/books`, respond((ctx) => bookService.list(ctx)));
  router.post(`${v1}/books`, respondCreated((ctx) => bookService.create(ctx)), { middleware: [write, idempotent('book.create')] });
  router.get(`${v1}/books/:bookId`, respond((ctx) => bookService.detail(ctx, ctx.param('bookId'))));
  router.patch(`${v1}/books/:bookId`, respond((ctx) => bookService.update(ctx, ctx.param('bookId'))), { middleware: [write] });
  router.get(`${v1}/bookmarks`, async (ctx) => {
    const { listBookmarks } = await import('./db/queries/content');
    const rows = await listBookmarks(ctx.env.TANWEER_DB, ctx.user?.id ?? '', ctx.q('entityType') ?? undefined, ctx.qInt('limit') ?? 50);
    return ok(rows.map((row) => ({ id: row.id, entityType: row.entity_type, entityId: row.entity_id, groupId: row.group_id, createdAt: row.created_at })));
  });

  // ── private notes ─────────────────────────────────────────────────────────
  router.get(`${v1}/notes`, respond((ctx) => noteService.list(ctx)));
  router.post(`${v1}/notes`, respondCreated((ctx) => noteService.create(ctx)), { middleware: [write, idempotent('note.create')] });
  router.patch(`${v1}/notes/:noteId`, respond((ctx) => noteService.update(ctx, ctx.param('noteId'))), { middleware: [write] });
  router.delete(`${v1}/notes/:noteId`, respond((ctx) => noteService.remove(ctx, ctx.param('noteId'))));

  // ── notifications ─────────────────────────────────────────────────────────
  router.get(`${v1}/notifications`, respond((ctx) => notificationService.list(ctx)));
  router.post(`${v1}/notifications/read`, respond((ctx) => notificationService.markRead(ctx)));
  router.get(`${v1}/notifications/preferences`, respond((ctx) => notificationService.preferences(ctx)));
  router.patch(`${v1}/notifications/preferences`, respond((ctx) => notificationService.updatePreferences(ctx)), { middleware: [write] });

  // ── search & sync ─────────────────────────────────────────────────────────
  router.get(`${v1}/search`, respond((ctx) => searchService.search(ctx)), {
    middleware: [rateLimit(POLICIES.search.bucket, POLICIES.search.limit, POLICIES.search.windowSeconds, { by: 'user' })],
  });
  router.get(`${v1}/sync`, respond((ctx) => syncService.pull(ctx)));
  router.get(`${v1}/sync/queue`, respond((ctx) => syncService.queuedCount(ctx)));

  // ── chat ──────────────────────────────────────────────────────────────────
  router.get(`${v1}/chat/rooms`, respond((ctx) => chatService.rooms(ctx)));
  router.get(`${v1}/chat/rooms/:roomId/messages`, respond((ctx) => chatService.messages(ctx, ctx.param('roomId'))));
  router.post(`${v1}/chat/rooms/:roomId/messages`, respondCreated((ctx) => chatService.send(ctx, ctx.param('roomId'))), {
    middleware: [rateLimit(POLICIES.chat.bucket, POLICIES.chat.limit, POLICIES.chat.windowSeconds, { by: 'user' }), idempotent('chat.send')],
  });
  router.post(`${v1}/chat/rooms/:roomId/read`, respond((ctx) => chatService.markRead(ctx, ctx.param('roomId'))));
  router.post(`${v1}/chat/rooms/:roomId/typing`, respond((ctx) => chatService.typing(ctx, ctx.param('roomId'))));
  router.get(`${v1}/chat/rooms/:roomId/presence`, respond((ctx) => chatService.presence(ctx, ctx.param('roomId'))));
  router.get(`${v1}/chat/rooms/:roomId/members`, respond((ctx) => chatService.members(ctx, ctx.param('roomId'))));
  router.post(`${v1}/chat/direct/:userId`, respond((ctx) => chatService.openDirect(ctx, ctx.param('userId'))));
  router.get(`${v1}/chat/group/:groupId`, respond((ctx) => chatService.roomForGroup(ctx, ctx.param('groupId'))));

  return router;
}
