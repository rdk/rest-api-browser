import { describe, expect, it } from 'vitest';
import { buildZip, crc32, javaSourceZipPath } from './zip';

describe('zip', () => {
  it('computes standard IEEE CRC-32', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('builds a valid PKZIP archive with local headers, central directory, and EOCD', () => {
    const zip = buildZip([
      { name: 'sources/com/example/Foo.java', data: 'public class Foo {}\n' },
      { name: 'metadata.json', data: '{"count":1,"note":"český"}' },
    ]);
    const view = new DataView(zip.buffer);
    // Local file header signature at byte 0
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // End of central directory at end - 22
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 8, true)).toBe(2);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = view.getUint32(eocd + 16, true);
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);
    const text = new TextDecoder().decode(zip);
    expect(text).toContain('sources/com/example/Foo.java');
    expect(text).toContain('public class Foo {}');
    expect(text).toContain('metadata.json');
    expect(text).toContain('český');
  });

  it('maps Java FQCNs to clean archive paths', () => {
    expect(javaSourceZipPath('com.atlassian.jira.rest.v2.ServerInfoBean')).toBe(
      'sources/com/atlassian/jira/rest/v2/ServerInfoBean.java',
    );
    expect(javaSourceZipPath('jakarta.ws.rs.core.Response$Status')).toBe(
      'sources/jakarta/ws/rs/core/Response$Status.java',
    );
  });
});
