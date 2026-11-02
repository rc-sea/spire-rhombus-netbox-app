import { describe, expect, it } from 'vitest';
import {
  buildCommand,
  buildStreamCommand,
  parseResponse,
  splitStreamDocuments,
} from '../src/nbapi/xml.js';

describe('buildCommand', () => {
  it('renders the guide envelope with session id and tzoffset', () => {
    const xml = buildCommand('GetPerson', { PERSONID: '21001' }, { sessionId: '900493538' });
    expect(xml).toBe(
      '<NETBOX-API sessionid="900493538">\n <COMMAND name="GetPerson" num="1" dateformat="tzoffset">\n  <PARAMS>\n   <PERSONID>21001</PERSONID>\n  </PARAMS>\n </COMMAND>\n</NETBOX-API>\n',
    );
  });

  it('omits PARAMS when there are none and escapes values', () => {
    expect(buildCommand('PingApp', undefined, { sessionId: 'a' })).toContain(
      '<COMMAND name="PingApp" num="1" dateformat="tzoffset">\n </COMMAND>',
    );
    expect(
      buildCommand('Login', { USERNAME: 'a<b', PASSWORD: 'p&q"' }, { tzOffset: false }),
    ).toContain('<USERNAME>a&lt;b</USERNAME>\n   <PASSWORD>p&amp;q&quot;</PASSWORD>');
  });

  it('uppercases tags and skips undefined params', () => {
    const xml = buildCommand('GetAccessHistory', { afterLogId: '5', MAXRECORDS: undefined });
    expect(xml).toContain('<AFTERLOGID>5</AFTERLOGID>');
    expect(xml).not.toContain('MAXRECORDS');
  });
});

describe('buildStreamCommand', () => {
  it('renders TAGNAMES with empty tags and filters as in the guide', () => {
    const xml = buildStreamCommand({ ACNAME: [], DESCNAME: [], PARTNAME: ['Master'] });
    expect(xml).toContain('<ACNAME />');
    expect(xml).toContain(
      '<PARTNAME>\n     <FILTERS>\n      <FILTER>Master</FILTER>\n     </FILTERS>\n    </PARTNAME>',
    );
    expect(xml).toContain('<COMMAND name="StreamEvents">');
    expect(xml).not.toContain('sessionid');
  });
});

describe('parseResponse', () => {
  it('parses the GetPerson example from the guide', () => {
    const r = parseResponse(`<NETBOX sessionid="900493538">
 <RESPONSE command="GetPerson" num="1">
  <CODE>SUCCESS</CODE>
   <DETAILS>
   <PERSONID>21001</PERSONID>
   <FIRSTNAME>Isaac</FIRSTNAME>
   <ACCESSLEVELS>
    <ACCESSLEVEL>My NetBox access level 1</ACCESSLEVEL>
    <ACCESSLEVEL>My NetBox access level 2</ACCESSLEVEL>
   </ACCESSLEVELS>
  </DETAILS>
 </RESPONSE>
</NETBOX>`);
    expect(r.sessionId).toBe('900493538');
    expect(r.command).toBe('GetPerson');
    expect(r.code).toBe('SUCCESS');
    expect(r.details?.PERSONID).toBe('21001');
    const levels = r.details?.ACCESSLEVELS as { ACCESSLEVEL: string[] } | undefined;
    expect(levels?.ACCESSLEVEL).toEqual(['My NetBox access level 1', 'My NetBox access level 2']);
  });

  it('parses APIERROR responses', () => {
    const r = parseResponse(
      '<NETBOX>\n  <RESPONSE>\n    <APIERROR>5</APIERROR>\n  </RESPONSE>\n</NETBOX>',
    );
    expect(r.apiError).toBe(5);
    expect(r.code).toBeUndefined();
  });

  it('parses FAIL with ERRMSG and NOT FOUND', () => {
    const fail = parseResponse(
      '<NETBOX sessionid="x"><RESPONSE command="GetAccessLevel" num="1"><CODE>FAIL</CODE><DETAILS><ERRMSG>Access Level Key required</ERRMSG></DETAILS></RESPONSE></NETBOX>',
    );
    expect(fail.code).toBe('FAIL');
    expect(fail.errMsg).toBe('Access Level Key required');
    const nf = parseResponse(
      '<NETBOX-API sessionid="x"><RESPONSE command=" GetAccessHistory" num="1"><CODE>NOT FOUND</CODE></RESPONSE></NETBOX-API>',
    );
    expect(nf.code).toBe('NOT FOUND');
    expect(nf.command).toBe('GetAccessHistory');
  });

  it('parses a StreamEvents document with CDATA values', () => {
    const r = parseResponse(`<NETBOX>
 <RESPONSE command="StreamEvents">
  <EVENT>
   <ACTIVITYID>976</ACTIVITYID>
   <DESCNAME><![CDATA[Event activated]]></DESCNAME>
   <CDT>2016-11-03 17:00:53.942949</CDT>
   <PARTNAME><![CDATA[Master]]></PARTNAME>
  </EVENT>
 </RESPONSE>
</NETBOX>`);
    const events = r.details?.EVENT as Record<string, string>[];
    expect(events).toHaveLength(1);
    expect(events[0]?.DESCNAME).toBe('Event activated');
    expect(events[0]?.ACTIVITYID).toBe('976');
  });

  it('treats a stream keep-alive as a response with no EVENT', () => {
    const r = parseResponse(
      '<NETBOX>\n <RESPONSE command="StreamEvents">\n </RESPONSE>\n</NETBOX>',
    );
    expect(r.details?.EVENT).toBeUndefined();
  });
});

describe('splitStreamDocuments', () => {
  it('splits complete documents and keeps the partial tail', () => {
    const a = '<NETBOX><RESPONSE command="StreamEvents"></RESPONSE></NETBOX>';
    const { docs, rest } = splitStreamDocuments(`${a}\n${a}\n<NETBOX><RESP`);
    expect(docs).toEqual([a, a]);
    expect(rest).toBe('<NETBOX><RESP');
  });

  it('does not confuse NETBOX-API with NETBOX closing tags', () => {
    const d =
      '<NETBOX-API sessionid="x"><RESPONSE command="Login"><CODE>SUCCESS</CODE></RESPONSE></NETBOX-API>';
    const { docs, rest } = splitStreamDocuments(d);
    // </NETBOX> does not occur inside </NETBOX-API>, so this stays buffered.
    expect(docs).toEqual([]);
    expect(rest).toBe(d);
  });
});
