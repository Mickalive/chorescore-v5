import { ContributionUnit } from '../../domain/entities';
import { ADD_LABEL_MAX_LENGTH, parsePositiveNumber } from '../../domain/services/addEntryService';
import { AllRepositories } from '../../infrastructure/repositories/RepositoryFactory';

export class ShortcutValidationError extends Error {}

/** Save an optional shortcut, never a realization or a balance operation. */
export async function saveTaskShortcut(repos: AllRepositories, input: {
  householdId: string; name: string; value: string; unit: ContributionUnit; beneficiaryMemberIds: string[];
}) {
  return repos.withTransaction(async () => {
    const name = input.name.trim();
    const value = parsePositiveNumber(input.value);
    const [household, members] = await Promise.all([
      repos.households.getById(input.householdId), repos.members.getByHousehold(input.householdId),
    ]);
    const ids = [...new Set(input.beneficiaryMemberIds)];
    if (!name || name.length > ADD_LABEL_MAX_LENGTH || value === null || !household || household.contributionUnit !== input.unit
      || ids.length === 0 || ids.some(id => !members.some(member => member.id === id))) {
      throw new ShortcutValidationError('Invalid shortcut or group changed');
    }
    return repos.tasks.create({ householdId: household.id, name, defaultValue: value,
      defaultUnit: input.unit, defaultBeneficiaryMemberIds: ids });
  });
}
