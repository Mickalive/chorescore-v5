import { CrossLedgerSettlement } from '../../domain/entities';
import { validateSettlementBalancePreconditions } from '../../domain/calculations/settlementPreconditions';
import { normalizeCurrency } from '../../domain/calculations/validation';
import { AllRepositories } from '../../infrastructure/repositories/RepositoryFactory';

export async function loadGroupBalances(repos: AllRepositories, householdId: string) {
  return repos.withTransaction(async () => {
    const household=await repos.households.getById(householdId);
    if (!household) throw new Error('Group unavailable');
    const members=await repos.members.getByHousehold(householdId);
    const snapshot=await repos.balanceProjections.getByHousehold(householdId,household.contributionUnit,members.map(member => member.id));
    return { household, members, snapshot };
  });
}

/** Serialize confirmation with current balances/settings. Two screens cannot
 * spend the same credit, and a stale preview cannot apply a changed rate.
 */
export async function createProjectedSettlement(repos: AllRepositories, input: Omit<CrossLedgerSettlement,'id'>): Promise<CrossLedgerSettlement> {
  return repos.withTransaction(async () => {
    const household=await repos.households.getById(input.householdId);
    if (!household?.crossLedgerCompensationEnabled) throw new Error('Compensation is disabled');
    const rate=household.contributionToMoneyRate;
    if (!rate || household.contributionUnit!==input.contributionUnit ||
        rate.contributionUnit!==input.rateSnapshot.contributionUnit || rate.contributionValue!==input.rateSnapshot.contributionValue ||
        rate.moneyAmountMinor!==input.rateSnapshot.moneyAmountMinor || normalizeCurrency(rate.currency)!==normalizeCurrency(input.rateSnapshot.currency)) {
      throw new Error('Compensation rate changed');
    }
    const members=await repos.members.getByHousehold(input.householdId);
    const ids=members.map(member => member.id);
    if (!ids.includes(input.contributionCreditorMemberId) || !ids.includes(input.counterpartyMemberId)) throw new Error('Unknown compensation member');
    const before=await repos.balanceProjections.getByHousehold(input.householdId,household.contributionUnit,ids);
    const created=await repos.settlements.create(input);
    const result=validateSettlementBalancePreconditions(created,before.contribution,
      before.moneyByCurrency.get(normalizeCurrency(input.currency)) ?? new Map());
    if (!result.valid) throw new Error(result.errors.join('; '));
    return created;
  });
}
