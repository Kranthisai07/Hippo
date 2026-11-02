import type { Repository } from "core/src/contracts";

/**
 * Makes sure a person's household record exists, with the address they signed in with as the digest address and the
 * daily email on. It never changes a record that is already there, so a setting the person saved stays as they left it.
 * The daily job skips a household that has no record, so without this a new person would never be reminded.
 * shortcut: read then write, so two first sign ins at the same instant could both write the same default. Harmless, and
 * a conditional write is the upgrade if a setting could ever change in that gap.
 */
export async function ensureHousehold(
  repo: Repository,
  who: { householdId: string; email: string },
  now: () => number,
): Promise<void> {
  if (await repo.getHousehold(who.householdId)) return;
  await repo.putHousehold(who.householdId, {
    id: who.householdId,
    email: who.email,
    digestOn: true,
    createdAt: new Date(now()).toISOString(),
  });
}
