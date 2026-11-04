/**
 * Tag service. A Tag belongs to one Household and points at zero or one
 * Chore. Its id is the {tagId} of the permanent URL /nfc/{tagId} (ADR 0001):
 * random, unguessable and URL-safe.
 */
import type { Clock } from "../clock";
import type { Db } from "../db/client";

/** 144 random bits, which encode to exactly 24 base64url characters. */
const TAG_ID_BYTES = 18;

export function newTagId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(TAG_ID_BYTES))).toString("base64url");
}

/** The path written onto a physical Tag. Frozen by ADR 0001. */
export function tagPath(tagId: string): string {
  return `/nfc/${tagId}`;
}

export type TagView = {
  id: string;
  path: string;
  chore: { id: string; name: string } | null;
};

/** A Tag as the Scan resolver needs it; null when the id is unknown. */
export type TagRecord = {
  id: string;
  householdId: string;
  /** The linked Chore, or null when none is linked or the linked Chore is Archived. */
  chore: { id: string; name: string } | null;
};

export type LinkResult = { ok: true; tag: TagView } | { ok: false; error: "tag_not_found" | "chore_not_found" };

export async function findTag(db: Db, tagId: string): Promise<TagRecord | null> {
  const [r] = await db`
    SELECT t.id, t.household_id, ch.id AS chore_id, ch.name AS chore_name
    FROM tags t LEFT JOIN chores ch ON ch.id = t.chore_id AND ch.archived_at IS NULL
    WHERE t.id = ${tagId}`;
  if (!r) return null;
  return {
    id: r.id,
    householdId: r.household_id,
    chore: r.chore_id ? { id: r.chore_id, name: r.chore_name } : null,
  };
}

export async function listTags(db: Db, householdId: string): Promise<TagView[]> {
  const rows = await db`
    SELECT t.id, ch.id AS chore_id, ch.name AS chore_name
    FROM tags t LEFT JOIN chores ch ON ch.id = t.chore_id AND ch.archived_at IS NULL
    WHERE t.household_id = ${householdId}
    ORDER BY t.created_at, t.id`;
  return rows.map(toView);
}

export async function createTag(
  deps: { db: Db; clock: Clock },
  input: { householdId: string; createdBy: string; choreId: string | null },
): Promise<LinkResult> {
  const { db, clock } = deps;
  if (input.choreId && !(await choreInHousehold(db, input.householdId, input.choreId))) {
    return { ok: false, error: "chore_not_found" };
  }
  const id = newTagId();
  await db`
    INSERT INTO tags (id, household_id, chore_id, created_at, created_by)
    VALUES (${id}, ${input.householdId}, ${input.choreId}, ${clock.now()}, ${input.createdBy})`;
  return { ok: true, tag: (await viewOf(db, input.householdId, id))! };
}

/** Points the Tag at a Chore of the same Household, or at none. */
export async function linkTag(
  db: Db,
  input: { householdId: string; tagId: string; choreId: string | null },
): Promise<LinkResult> {
  if (input.choreId && !(await choreInHousehold(db, input.householdId, input.choreId))) {
    return { ok: false, error: "chore_not_found" };
  }
  const updated = await db`
    UPDATE tags SET chore_id = ${input.choreId}
    WHERE id = ${input.tagId} AND household_id = ${input.householdId}
    RETURNING id`;
  if (updated.length === 0) return { ok: false, error: "tag_not_found" };
  return { ok: true, tag: (await viewOf(db, input.householdId, input.tagId))! };
}

async function choreInHousehold(db: Db, householdId: string, choreId: string): Promise<boolean> {
  const rows = await db`
    SELECT 1 FROM chores
    WHERE id = ${choreId}::uuid AND household_id = ${householdId} AND archived_at IS NULL`.catch(() => []);
  return rows.length > 0;
}

async function viewOf(db: Db, householdId: string, tagId: string): Promise<TagView | null> {
  const [r] = await db`
    SELECT t.id, ch.id AS chore_id, ch.name AS chore_name
    FROM tags t LEFT JOIN chores ch ON ch.id = t.chore_id AND ch.archived_at IS NULL
    WHERE t.id = ${tagId} AND t.household_id = ${householdId}`;
  return r ? toView(r) : null;
}

function toView(r: any): TagView {
  return {
    id: r.id,
    path: tagPath(r.id),
    chore: r.chore_id ? { id: r.chore_id, name: r.chore_name } : null,
  };
}
