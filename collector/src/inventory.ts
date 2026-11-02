/**
 * NetBox inventory for the mapping UI: readers, portals (with readers),
 * elevators, floors and configured event names.
 */
import { type InventoryItem, type InventorySnapshot, SCHEMA_VERSION } from '@spire/shared';
import type { Logger } from 'pino';
import type { NbapiClient } from './nbapi/client.js';
import { getElevators, getFloors, getPortals, getReaders, listEvents } from './nbapi/commands.js';

export async function takeInventory(
  netbox: NbapiClient,
  collectorId: string,
  log: Logger,
): Promise<InventorySnapshot> {
  const items: InventoryItem[] = [];
  const readers = await getReaders(netbox);
  for (const r of readers) {
    const item: InventoryItem = { type: 'reader', key: r.key, name: r.name };
    if (r.description) item.description = r.description;
    items.push(item);
  }
  const portals = await getPortals(netbox);
  for (const p of portals) {
    items.push({
      type: 'portal',
      key: p.key,
      name: p.name,
      readers: p.readers.map((r) =>
        r.order !== undefined
          ? { key: r.key, name: r.name, order: r.order }
          : { key: r.key, name: r.name },
      ),
    });
  }
  // Elevators, floors and events are best-effort: firmware differences must not block readers/portals.
  for (const [label, fn] of [
    [
      'elevator',
      async () =>
        (await getElevators(netbox)).map((e) => ({
          type: 'elevator' as const,
          key: e.key,
          name: e.name,
          raw: e.raw,
        })),
    ],
    [
      'floor',
      async () =>
        (await getFloors(netbox)).map((f) => ({
          type: 'floor' as const,
          key: f.key,
          name: f.name,
          raw: f.raw,
        })),
    ],
    [
      'event',
      async () =>
        (await listEvents(netbox)).map((n) => ({ type: 'event' as const, key: n, name: n })),
    ],
  ] as const) {
    try {
      items.push(...(await fn()));
    } catch (err) {
      log.warn(
        { err: (err as Error).message, type: label },
        'inventory: optional list unavailable',
      );
    }
  }
  return { schemaVersion: SCHEMA_VERSION, collectorId, takenAt: new Date().toISOString(), items };
}
