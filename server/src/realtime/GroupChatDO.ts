/**
 * GroupChatDO — the realtime half of the conversation (§104).
 *
 * Responsibilities
 *   • owns the message order (it is the only single-threaded place, so the
 *     sequence number is race free);
 *   • keeps a small ring buffer of the most recent messages so a client that
 *     reconnects can catch up instantly;
 *   • fans out to every connected socket and reports presence;
 *   • never stores files.
 *
 * It is a SQLite-backed Durable Object, so it uses `ctx.storage.sql` only and
 * survives hibernation: socket identity travels inside the socket attachment.
 */
import type { Env } from '../env';
import { internalToken } from '../lib/crypto';

const RING_SIZE = 200;
const MAX_BODY_LENGTH = 4000;

interface SocketAttachment {
  userId: string;
  name: string;
  roomId: string;
}

interface OutgoingMessage {
  type: 'message' | 'presence' | 'typing' | 'ready' | 'read' | 'error';
  [key: string]: unknown;
}

export class GroupChatDO {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS messages (
           id TEXT PRIMARY KEY,
           seq INTEGER NOT NULL,
           sender_id TEXT NOT NULL,
           sender_name TEXT NOT NULL,
           body TEXT,
           kind TEXT NOT NULL DEFAULT 'TEXT',
           file_id TEXT,
           reply_to_id TEXT,
           created_at TEXT NOT NULL
         )`,
      );
      this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_do_messages_seq ON messages (seq DESC)');
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS counters (
           name TEXT PRIMARY KEY,
           value INTEGER NOT NULL
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    if (upgrade === 'websocket') return this.handleUpgrade(request);

    switch (url.pathname) {
      case '/ingest':
        return this.handleIngest(request);
      case '/typing':
        return this.handleTyping(request);
      case '/presence':
        return this.json(this.presencePayload());
      case '/history':
        return this.handleHistory(url);
      case '/health':
        return this.json({ ok: true, sockets: this.ctx.getWebSockets().length });
      default:
        return this.json({ error: 'not_found' }, 404);
    }
  }

  // ── internal API (Worker → DO) ─────────────────────────────────────────────

  private async isInternal(request: Request): Promise<boolean> {
    const provided = request.headers.get('x-tanweer-internal') ?? '';
    const expected = await internalToken(this.env);
    return provided.length > 0 && provided === expected;
  }

  private async handleIngest(request: Request): Promise<Response> {
    if (!(await this.isInternal(request))) return this.json({ error: 'forbidden' }, 403);
    const payload = (await request.json()) as {
      roomId: string;
      message: {
        id: string;
        senderId: string;
        senderName: string;
        body: string | null;
        kind: 'TEXT' | 'ATTACHMENT' | 'SYSTEM';
        fileId: string | null;
        replyToId: string | null;
        createdAt: string;
      };
    };

    const seq = this.nextSeq();
    const message = payload.message;
    const body = message.body && message.body.length > MAX_BODY_LENGTH ? message.body.slice(0, MAX_BODY_LENGTH) : message.body;

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO messages (id, seq, sender_id, sender_name, body, kind, file_id, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id,
      seq,
      message.senderId,
      message.senderName,
      body,
      message.kind,
      message.fileId,
      message.replyToId,
      message.createdAt,
    );
    this.ctx.storage.sql.exec(
      'DELETE FROM messages WHERE seq <= (SELECT MAX(seq) - ? FROM messages)',
      RING_SIZE,
    );

    this.broadcast({
      type: 'message',
      roomId: payload.roomId,
      seq,
      message: { ...message, body },
    });

    return this.json({ seq });
  }

  private async handleTyping(request: Request): Promise<Response> {
    if (!(await this.isInternal(request))) return this.json({ error: 'forbidden' }, 403);
    const payload = (await request.json()) as { roomId: string; userId: string; name: string };
    this.broadcast({ type: 'typing', roomId: payload.roomId, userId: payload.userId, name: payload.name }, payload.userId);
    return this.json({ ok: true });
  }

  private handleHistory(url: URL): Response {
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, RING_SIZE);
    const before = Number.parseInt(url.searchParams.get('before') ?? '0', 10) || 0;
    const rows = before > 0
      ? this.ctx.storage.sql.exec('SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?', before, limit).toArray()
      : this.ctx.storage.sql.exec('SELECT * FROM messages ORDER BY seq DESC LIMIT ?', limit).toArray();
    return this.json({ items: rows.reverse() });
  }

  private nextSeq(): number {
    const row = this.ctx.storage.sql.exec<{ value: number }>('SELECT value FROM counters WHERE name = ?', 'seq').toArray()[0];
    const next = (row?.value ?? 0) + 1;
    this.ctx.storage.sql.exec(
      'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value',
      'seq',
      next,
    );
    return next;
  }

  // ── websocket surface ─────────────────────────────────────────────────────

  private handleUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const userId = request.headers.get('x-tanweer-user-id') ?? url.searchParams.get('userId') ?? '';
    const name = decodeURIComponent(request.headers.get('x-tanweer-user-name') ?? '');
    const roomId = request.headers.get('x-tanweer-room-id') ?? url.searchParams.get('roomId') ?? '';
    if (userId.length === 0) return this.json({ error: 'unauthorized' }, 401);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = { userId, name, roomId };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: 'ready', roomId, seq: this.currentSeq(), presence: this.presencePayload() } as OutgoingMessage));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = (ws.deserializeAttachment() ?? { userId: '', name: '', roomId: '' }) as SocketAttachment;
    if (typeof message !== 'string') return;
    if (message.length > 8000) return;

    let payload: { type?: string; seq?: number; body?: string };
    try {
      payload = JSON.parse(message) as { type?: string; seq?: number; body?: string };
    } catch {
      return;
    }

    switch (payload.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
        return;
      case 'typing':
        this.broadcast({ type: 'typing', roomId: attachment.roomId, userId: attachment.userId, name: attachment.name }, attachment.userId);
        return;
      case 'read':
        // Read receipts travel through the HTTP API so they land in D1.
        this.broadcast({ type: 'read', roomId: attachment.roomId, userId: attachment.userId, seq: payload.seq ?? 0 }, attachment.userId);
        return;
      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    void code;
    void reason;
    void wasClean;
    try {
      ws.close();
    } catch {
      // already closed
    }
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    void error;
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  private currentSeq(): number {
    const row = this.ctx.storage.sql.exec<{ value: number }>('SELECT value FROM counters WHERE name = ?', 'seq').toArray()[0];
    return row?.value ?? 0;
  }

  private presencePayload(): { online: number; members: string[] } {
    const sockets = this.ctx.getWebSockets();
    const members = new Set<string>();
    for (const socket of sockets) {
      const attachment = (socket.deserializeAttachment() ?? null) as SocketAttachment | null;
      if (attachment?.userId) members.add(attachment.userId);
    }
    return { online: members.size, members: [...members] };
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', ...this.presencePayload() });
  }

  private broadcast(payload: OutgoingMessage, exceptUserId?: string): void {
    const text = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = (socket.deserializeAttachment() ?? null) as SocketAttachment | null;
      if (exceptUserId && attachment?.userId === exceptUserId) continue;
      try {
        socket.send(text);
      } catch {
        // socket died; the close handler will clean up
      }
    }
  }

  private json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
}
