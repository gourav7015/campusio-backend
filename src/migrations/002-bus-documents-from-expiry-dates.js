import { Bus, BusDocument } from '../models/index.js';

export const id = '002-bus-documents-from-expiry-dates';
export const description = 'Turns the insurance, fitness and pollution dates already on each bus into vehicle document records (without a copy), so they show in the new Documents list.';

const FIELDS = { insurance: 'insuranceExpiry', fitness: 'fitnessExpiry', pollution: 'pollutionExpiry' };
export async function up() {
  for (const b of await Bus.find({}).lean()) {
    for (const [type, field] of Object.entries(FIELDS)) {
      if (!b[field]) continue;
      await BusDocument.updateOne({ tenantId: b.tenantId, busId: b._id, type }, { $setOnInsert: { expiresOn: b[field], updatedByName: 'Moved from the bus record' } }, { upsert: true });
    }
  }
}
