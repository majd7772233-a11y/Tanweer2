/**
 * Identifiers are random, prefixed and slightly time-sortable — never exposed
 * sequential integers (§100). Example: `cnt_m2k9x4a1f0b7c3d5e6a8b9c0d`.
 *
 * The prefix makes logs and D1 rows readable, the timestamp prefix keeps rows
 * roughly ordered by creation which helps indexes and pagination.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type IdPrefix =
  | 'usr' | 'dev' | 'ses' | 'ay' | 'grp' | 'gsec' | 'gmbr' | 'greq'
  | 'schv' | 'slot' | 'sprp' | 'hday'
  | 'cnt' | 'cmed' | 'ccon' | 'crel' | 'crev' | 'cmnt' | 'rctn' | 'bkmk'
  | 'file' | 'uint' | 'note' | 'pin'
  | 'hw' | 'hwcp' | 'exam' | 'evnt'
  | 'iss' | 'icmt' | 'crq' | 'drq' | 'vote' | 'tnom'
  | 'chat' | 'cmsg'
  | 'ntf' | 'nprf' | 'book' | 'bsrc'
  | 'idem' | 'audit' | 'rl';

function randomChars(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return out;
}

function timePart(now: Date): string {
  // 8 chars of base36 milliseconds: ordered for ~90 years, unique enough.
  return now.getTime().toString(36).padStart(8, '0');
}

export function newId(prefix: IdPrefix, now: Date = new Date()): string {
  return `${prefix}_${timePart(now)}${randomChars(12)}`;
}

/** Deterministic ids are used only for seeded structure (grades, class groups). */
export function classGroupId(gradeId: number, sectionCode: string): string {
  return `grp_class_${gradeId}-${sectionCode}`;
}

export function classId(gradeId: number, sectionCode: string): string {
  return `${gradeId}-${sectionCode}`;
}

export function chatRoomIdForGroup(groupId: string): string {
  return `chat_${groupId}`;
}

export function scheduleVersionIdForGroup(groupId: string): string {
  return `schv_${groupId}`;
}
