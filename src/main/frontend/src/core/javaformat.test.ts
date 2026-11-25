import { describe, expect, it } from 'vitest';
import { formatJavaSource } from './javaformat';

describe('javaformat', () => {
  it('reformats compressed CFR annotations, spacing, indentation, and blank lines', () => {
    const raw = [
      'package com.example.rest;',
      'import jakarta.ws.rs.GET;',
      'import jakarta.ws.rs.core.Response;',
      'public class DemoResource {',
      '   @GET',
      '   @ApiResponses({@ApiResponse(content=@Content(array=@ArraySchema(schema=@Schema(implementation=RestUsageInfoResponse.class)), mediaType="application/json"), description="A JSON response", responseCode="200"), @ApiResponse(description="Missing", responseCode="400")})',
      '   public final Response getUsage(@QueryParam("pluginKey") String key) {',
      '      if(key==null){return Response.status(400).build();}',
      '      return Response.ok().build();',
      '   }',
      '   private void helper(){doA();doB();}',
      '}',
    ].join('\n');

    const pretty = formatJavaSource(raw);
    expect(pretty).toContain('package com.example.rest;\n\nimport jakarta.ws.rs.GET;');
    expect(pretty).toContain('import jakarta.ws.rs.core.Response;\n\npublic class DemoResource {');
    // Long single-line @ApiResponses annotation expanded across multiple indented lines
    expect(pretty).toContain('    @ApiResponses({\n        @ApiResponse(');
    expect(pretty).toContain('implementation = RestUsageInfoResponse.class');
    // Compressed control block and method block expanded with 4-space indentation
    expect(pretty).toContain('        if (key==null) {\n            return Response.status(400).build();\n        }');
    expect(pretty).toContain('    private void helper() {\n        doA();\n        doB();\n    }');
  });

  it('wraps long method signatures and preserves comments, strings, and empty blocks', () => {
    const raw = [
      'public class LongSig {',
      '    // keep if(x){y();} inside comment',
      '    public Response fetch(@QueryParam("pluginKey") String pluginKey, @QueryParam("expand") String expand, @QueryParam("maxResults") int maxResults) {',
      '        String s = "if(a){b();}";',
      '        return Response.ok(s).build();',
      '    }',
      '    public void noop() {}',
      '}',
    ].join('\n');
    const pretty = formatJavaSource(raw);
    expect(pretty).toContain('    // keep if(x){y();} inside comment');
    expect(pretty).toContain('String s = "if(a){b();}";');
    expect(pretty).toContain('    public Response fetch(\n        @QueryParam("pluginKey") String pluginKey,\n        @QueryParam("expand") String expand,\n        @QueryParam("maxResults") int maxResults\n    ) {');
    expect(pretty).toContain('    public void noop() {}');
  });
});
