/**
 * Resolve which Rhombus cameras an event should be published to.
 * Precedence: reader → portal → elevator/node → event name → settings default.
 */
import type { BridgeEvent } from '@spire/shared';
import type { Mapping, Settings } from './db/repo';

export interface ResolvedTargets {
  cameras: string[];
  /** Which mapping level matched, for the UI. */
  matchedBy: 'reader' | 'portal' | 'elevator' | 'event' | 'catch-all' | 'none' | 'kind-disabled';
  overlay: boolean;
  colorOverride: Mapping['colorOverride'];
}

function norm(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Mappings are keyed by NetBox key; the event carries names (and keys for history). */
function matches(m: Mapping, type: Mapping['sourceType'], e: BridgeEvent): boolean {
  if (!m.enabled || m.sourceType !== type) return false;
  const n = e.netbox;
  switch (type) {
    case 'reader':
      return (
        (n.readerKey !== undefined && m.sourceKey === n.readerKey) ||
        norm(m.sourceNameSnapshot) === norm(n.readerName)
      );
    case 'portal':
      return (
        (n.portalKey !== undefined && m.sourceKey === n.portalKey) ||
        norm(m.sourceNameSnapshot) === norm(n.portalName)
      );
    case 'elevator':
      return (
        norm(m.sourceNameSnapshot) === norm(n.nodeName) ||
        norm(m.sourceNameSnapshot) === norm(n.readerName)
      );
    case 'event':
      return (
        norm(m.sourceKey) === norm(n.eventName) || norm(m.sourceNameSnapshot) === norm(n.eventName)
      );
  }
}

export function resolveTargets(
  e: BridgeEvent,
  mappings: Mapping[],
  settings: Settings,
): ResolvedTargets {
  const overlayDefault = settings.overlayKinds.includes(e.kind);
  if (!settings.publishKinds.includes(e.kind)) {
    return {
      cameras: [],
      matchedBy: 'kind-disabled',
      overlay: overlayDefault,
      colorOverride: null,
    };
  }
  for (const type of ['reader', 'portal', 'elevator', 'event'] as const) {
    const hits = mappings.filter((m) => matches(m, type, e));
    if (hits.length > 0) {
      const cameras = [...new Set(hits.map((h) => h.cameraUuid))];
      const overlay =
        hits.some((h) => h.overlay === true) ||
        (hits.every((h) => h.overlay === null) && overlayDefault);
      const colorOverride = hits.find((h) => h.colorOverride)?.colorOverride ?? null;
      return { cameras, matchedBy: type, overlay, colorOverride };
    }
  }
  if (settings.unmappedPolicy === 'catch-all' && settings.catchAllCamera) {
    return {
      cameras: [settings.catchAllCamera],
      matchedBy: 'catch-all',
      overlay: overlayDefault,
      colorOverride: null,
    };
  }
  return { cameras: [], matchedBy: 'none', overlay: overlayDefault, colorOverride: null };
}
