import catalogJson from '../catalog/models.json';
import type { Catalog, CatalogModel, CatalogQuant } from './types';

// Phase 1: the catalog ships inside the package as static JSON (regenerate with
// `npm run catalog`). Later it moves to a hosted endpoint with this as the fallback.
const catalog = catalogJson as unknown as Catalog;

export function getCatalog(): Catalog {
  return catalog;
}

export function getModel(id: string): CatalogModel | undefined {
  return catalog.models.find((m) => m.id === id);
}

export function requireModel(id: string): CatalogModel {
  const m = getModel(id) ?? catalog.models.find((x) => x.id.toLowerCase() === id.toLowerCase() || x.name.toLowerCase() === id.toLowerCase());
  if (!m) throw new Error(`Unknown model "${id}". Run \`localmax models\` to see the catalog.`);
  return m;
}

export function getQuant(model: CatalogModel, quantId: string): CatalogQuant {
  const q = model.quants.find((x) => x.id.toLowerCase() === quantId.toLowerCase());
  if (!q) throw new Error(`${model.name} has no ${quantId} quant. Available: ${model.quants.map((x) => x.id).join(', ')}`);
  return q;
}
