import { Budget, Expense } from '../models/index.js';

export const id = '003-budget-kinds';
export const description = 'Budgets and expenses are now revenue (running costs) or capital (assets). Everything already recorded is revenue, and the old one-per-department budget index is replaced by one that includes the kind.';

export async function up() {
  await Budget.updateMany({ kind: { $exists: false } }, { $set: { kind: 'revenue' } });
  await Expense.updateMany({ nature: { $exists: false } }, { $set: { nature: 'revenue' } });
  try { await Budget.collection.dropIndex('tenantId_1_yearId_1_department_1_work_1'); } catch { /* already gone, or a fresh database that never had it */ }
  await Budget.syncIndexes();
}
