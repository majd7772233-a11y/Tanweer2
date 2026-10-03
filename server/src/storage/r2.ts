/**
 * R2 helpers. The bucket stores bytes only; every fact about a file lives in
 * D1 (files table) (§47, §81).
 */
import type { Env } from '../env';

export interface ObjectMetadata {
  objectKey: string;
  size: number;
  etag: string;
  contentType: string | null;
}

export function buildObjectKey(input: { purpose: string; ownerId: string; fileId: string; extension: string }): string {
  return `tanweer/${input.purpose.toLowerCase()}/${input.ownerId}/${input.fileId}.${input.extension}`;
}

export async function putObject(
  env: Env,
  objectKey: string,
  body: ReadableStream | ArrayBuffer | Uint8Array | string,
  httpMetadata: R2HTTPMetadata,
): Promise<ObjectMetadata | null> {
  const object = await env.TANWEER_FILES.put(objectKey, body, { httpMetadata });
  if (!object) return null;
  return { objectKey, size: object.size, etag: object.httpEtag, contentType: object.httpMetadata?.contentType ?? null };
}

export async function headObject(env: Env, objectKey: string): Promise<ObjectMetadata | null> {
  const object = await env.TANWEER_FILES.head(objectKey);
  if (!object) return null;
  return { objectKey, size: object.size, etag: object.httpEtag, contentType: object.httpMetadata?.contentType ?? null };
}

export async function getObject(env: Env, objectKey: string, range?: R2Range): Promise<R2ObjectBody | null> {
  return env.TANWEER_FILES.get(objectKey, range ? { range } : undefined);
}

export async function deleteObject(env: Env, objectKey: string): Promise<void> {
  await env.TANWEER_FILES.delete(objectKey);
}

export async function deleteObjects(env: Env, objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;
  await env.TANWEER_FILES.delete(objectKeys);
}

export async function objectExists(env: Env, objectKey: string): Promise<boolean> {
  return (await env.TANWEER_FILES.head(objectKey)) !== null;
}

/** Storage accounting for the monitoring screen (§142). */
export async function bucketStats(env: Env, prefix = 'tanweer/'): Promise<{ objects: number; bytes: number }> {
  let cursor: string | undefined;
  let objects = 0;
  let bytes = 0;
  for (let page = 0; page < 10; page += 1) {
    const listing = await env.TANWEER_FILES.list({ prefix, cursor, limit: 1000 });
    objects += listing.objects.length;
    for (const object of listing.objects) bytes += object.size;
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
  return { objects, bytes };
}
