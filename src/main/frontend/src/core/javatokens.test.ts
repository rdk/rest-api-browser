import { describe, expect, it } from 'vitest';
import { annotationTokens, toLines, tokenize, type Token } from './javatokens';

const show = (ts: Token[]) => ts.map((t) => (t.kind === 'space' ? t.text : `${t.kind}:${t.text}`)).join('|');
const text = (ts: Token[]) => ts.map((t) => t.text).join('');

describe('javatokens', () => {
  it('tells annotations, members, strings, types, keywords and punctuation apart', () => {
    expect(show(tokenize('@PathParam("id")'))).toBe('ann:@PathParam|punct:(|str:"id"|punct:)');
    expect(show(tokenize('summary="a \\"b\\"", type=Bean.class, n=5L, state=Thread.State.BLOCKED'))).toBe(
      'member:summary|punct:=|str:"a \\"b\\""|punct:,| |member:type|punct:=|type:Bean|punct:.|kw:class|punct:,| |'
      + 'member:n|punct:=|num:5L|punct:,| |member:state|punct:=|type:Thread|punct:.|type:State|punct:.|num:BLOCKED');
    expect(show(tokenize('public Map<String, List<int[]>> get'))).toBe(
      'kw:public| |type:Map|punct:<|type:String|punct:,| |type:List|punct:<|kw:int|punct:[|punct:]|punct:>|punct:>| |name:get');
  });

  it('keeps a short annotation on one line, with spaces around =', () => {
    expect(text(annotationTokens('@ScopesAllowed(requiredScope="READ")'))).toBe('@ScopesAllowed(requiredScope = "READ")');
    expect(text(annotationTokens('@GET'))).toBe('@GET');
    expect(text(annotationTokens('@Path("{id}")'))).toBe('@Path("{id}")');
    expect(text(annotationTokens('@Tags({"a", "b"})'))).toBe('@Tags({"a", "b"})');
  });

  it('lays a long annotation out one member per line, nested ones too', () => {
    const s = '@ApiResponse(content=@Content(mediaType="application/json", schema=@Schema(implementation=ServerInfoBean.class)), '
      + 'description="Returns a full representation of the server info in JSON format.", responseCode="200")';
    expect(text(annotationTokens(s, 70))).toBe([
      '@ApiResponse(',
      '    content = @Content(',
      '        mediaType = "application/json",',
      '        schema = @Schema(implementation = ServerInfoBean.class)',
      '    ),',
      '    description = "Returns a full representation of the server info in JSON format.",',
      '    responseCode = "200"',
      ')',
    ].join('\n'));
    const kinds = new Set(annotationTokens(s, 70).map((t) => t.kind));
    expect([...kinds].sort()).toEqual(['ann', 'kw', 'member', 'punct', 'space', 'str', 'type']);
  });

  it('breaks a long string at its \n escapes into concatenated parts, aligned', () => {
    const s = '@Operation(description="First line.\\nSecond line, which is longer.\\nThird.", summary="S")';
    expect(text(annotationTokens(s, 40))).toBe([
      '@Operation(',
      '    description = "First line.\\n" +',
      '                  "Second line, which is longer.\\n" +',
      '                  "Third."',
      '    summary = "S"',
      ')',
    ].join('\n').replace('"Third."\n', '"Third.",\n'));
    // short enough, or without breaks: one token
    expect(text(annotationTokens('@Op(description="a\\nb")'))).toBe('@Op(description = "a\\nb")');
  });

  it('turns tokens into lines with their indentation', () => {
    const lines = toLines(annotationTokens('@A(x="1", y="2")', 10));
    expect(lines.map((l) => [l.indent, text(l.tokens)])).toEqual([[0, '@A('], [4, 'x = "1",'], [4, 'y = "2"'], [0, ')']]);
  });

  it('gives back text it cannot read as plain tokens', () => {
    const clipped = '@Operation(summary="Get general information abo…';
    expect(text(annotationTokens(clipped))).toBe(clipped);
  });
});
