/**
 * NBAPI XML envelope: build command documents and parse NETBOX responses.
 * Tag names are uppercase as the guide requires.
 */
import { XMLParser } from 'fast-xml-parser';
import type { NbapiResponse } from './types.js';

export type ParamValue = string | number | boolean | null | undefined | ParamNode | ParamNode[];
export interface ParamNode {
  [tag: string]: ParamValue;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderParams(node: ParamNode, indent: string): string {
  let out = '';
  for (const [tag, value] of Object.entries(node)) {
    if (value === undefined || value === null) continue;
    const TAG = tag.toUpperCase();
    if (Array.isArray(value)) {
      for (const item of value)
        out += `${indent}<${TAG}>\n${renderParams(item, `${indent}  `)}${indent}</${TAG}>\n`;
    } else if (typeof value === 'object') {
      out += `${indent}<${TAG}>\n${renderParams(value, `${indent}  `)}${indent}</${TAG}>\n`;
    } else {
      out += `${indent}<${TAG}>${escapeXml(String(value))}</${TAG}>\n`;
    }
  }
  return out;
}

export interface BuildCommandOptions {
  sessionId?: string | undefined;
  /** Default true: ask NetBox for GMT-offset timestamps. */
  tzOffset?: boolean;
  /** Empty-element tags to request (StreamEvents TAGNAMES). Rendered as `<TAG />`. */
  emptyTags?: string[];
}

/** Build a NETBOX-API command document. */
export function buildCommand(
  name: string,
  params: ParamNode | undefined,
  opts: BuildCommandOptions = {},
): string {
  const session = opts.sessionId ? ` sessionid="${escapeXml(opts.sessionId)}"` : '';
  const dateformat = opts.tzOffset === false ? '' : ' dateformat="tzoffset"';
  let body = '';
  if (params && Object.keys(params).length > 0) {
    body = `  <PARAMS>\n${renderParams(params, '   ')}  </PARAMS>\n`;
  }
  return `<NETBOX-API${session}>\n <COMMAND name="${escapeXml(name)}" num="1"${dateformat}>\n${body} </COMMAND>\n</NETBOX-API>\n`;
}

/**
 * Build the StreamEvents request: TAGNAMES with optional per-tag FILTERS.
 * e.g. tags = { DESCNAME: [], PARTNAME: ['Master'] }
 */
export function buildStreamCommand(tags: Record<string, string[]>): string {
  let tagXml = '';
  for (const [tag, filters] of Object.entries(tags)) {
    const TAG = tag.toUpperCase();
    if (filters.length === 0) {
      tagXml += `    <${TAG} />\n`;
    } else {
      tagXml += `    <${TAG}>\n     <FILTERS>\n`;
      for (const f of filters) tagXml += `      <FILTER>${escapeXml(f)}</FILTER>\n`;
      tagXml += `     </FILTERS>\n    </${TAG}>\n`;
    }
  }
  return `<NETBOX-API>\n <COMMAND name="StreamEvents">\n  <PARAMS>\n   <TAGNAMES>\n${tagXml}   </TAGNAMES>\n  </PARAMS>\n </COMMAND>\n</NETBOX-API>\n`;
}

/** Elements that may repeat and must always parse as arrays. */
const ALWAYS_ARRAY = new Set([
  'ACCESS',
  'READER',
  'PORTAL',
  'ELEVATOR',
  'FLOOR',
  'EVENT',
  'EVENTNAME',
  'ACCESSLEVEL',
  'FILTER',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: false,
  isArray: (name) => ALWAYS_ARRAY.has(name),
});

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

/** Collapse `{ '#text': 'x' }` leaves to plain strings, recursively. */
function simplify(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(simplify);
  const r = asRecord(v);
  if (!r) return v;
  const keys = Object.keys(r);
  if (keys.length === 1 && keys[0] === '#text') return r['#text'];
  const out: Json = {};
  for (const k of keys) out[k] = simplify(r[k]);
  return out;
}

/** Parse one NETBOX response document. */
export function parseResponse(xml: string): NbapiResponse {
  const doc = asRecord(parser.parse(xml));
  const netbox = asRecord(doc?.NETBOX) ?? asRecord(doc?.['NETBOX-API']);
  if (!netbox) throw new Error('Not a NETBOX response document');
  const response = asRecord(netbox.RESPONSE);
  const out: NbapiResponse = {};
  const sid = netbox['@_sessionid'];
  if (typeof sid === 'string' && sid) out.sessionId = sid;
  if (!response) return out;
  const cmd = response['@_command'] ?? response['@_name'];
  if (typeof cmd === 'string') out.command = cmd.trim();
  if (response.APIERROR !== undefined) {
    const n = Number(simplify(response.APIERROR));
    if (!Number.isNaN(n)) out.apiError = n;
  }
  const code = simplify(response.CODE);
  if (typeof code === 'string') out.code = code.trim();
  const details = asRecord(simplify(response.DETAILS));
  if (details) {
    out.details = details;
    if (typeof details.ERRMSG === 'string') out.errMsg = details.ERRMSG;
  } else if (typeof response.DETAILS === 'string') {
    // GetEventHistory returns CSV text directly inside DETAILS.
    out.details = { '#text': response.DETAILS };
  }
  // StreamEvents puts EVENT blocks directly under RESPONSE.
  if (response.EVENT !== undefined) {
    out.details = { ...(out.details ?? {}), EVENT: simplify(response.EVENT) };
  }
  return out;
}

/**
 * Split a stream buffer into complete `<NETBOX>…</NETBOX>` documents.
 * Returns the documents found and the unconsumed remainder.
 */
export function splitStreamDocuments(buffer: string): { docs: string[]; rest: string } {
  const docs: string[] = [];
  let rest = buffer;
  for (;;) {
    const start = rest.indexOf('<NETBOX');
    if (start < 0) {
      return { docs, rest: '' };
    }
    const end = rest.indexOf('</NETBOX>', start);
    if (end < 0) {
      return { docs, rest: rest.slice(start) };
    }
    docs.push(rest.slice(start, end + '</NETBOX>'.length));
    rest = rest.slice(end + '</NETBOX>'.length);
  }
}
