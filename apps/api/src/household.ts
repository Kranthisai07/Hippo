import type { Repository } from "core/src/contracts";

/**
 * Makes sure a person's household record exists, with the address they signed in with as the digest address and the
 * daily email on. For a record that is already there only the address is brought in line with the sign in address, so
 * the on or off setting a person saved stays as they left it.
 * The daily job skips a household that has no record, so without this a new person would never be reminded.
 * shortcut: read then write, so two first sign ins at the same instant could both write the same default. Harmless, and
 * a conditional write is the upgrade if a setting could ever change in that gap.
 */
export async function ensureHousehold(
  repo: Repository,
  who: { householdId: string; email: string },
  now: () => number,
): Promise<void> {
  const existing = await repo.getHousehold(who.householdId);
  if (existing) {
    // Only the address, and only to the one just proved: a record written before the daily email was tied to the sign in
    // address may hold another. The daily on or off choice is the person's and is left alone.
    if (existing.email !== who.email) await repo.putHousehold(who.householdId, { ...existing, email: who.email });
    return;
  }
  await repo.putHousehold(who.householdId, {
    id: who.householdId,
    email: who.email,
    digestOn: true,
    createdAt: new Date(now()).toISOString(),
  });
}
