package com.atlassian.labs.restbrowser.jaxrs;

import org.junit.Test;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.reflect.Method;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class ReflectiveBridgeAndFormattersTest {

    @Retention(RetentionPolicy.RUNTIME)
    public @interface BigAnn {
        String a() default "";
        String b() default "";
        String[] arr() default {};
    }

    @Retention(RetentionPolicy.RUNTIME)
    public @interface HighSurrogateAnn {
        String value();
    }

    public static class SampleTarget {
        public String echo(String s) {
            return s;
        }

        @BigAnn(a = "alpha", b = "beta", arr = {"x", "y"})
        @HighSurrogateAnn("😀")
        public void annotated() {
        }
    }

    @Test
    public void reflectiveBridgeIsolatesCacheKeyFromMutatedParameterArray() throws Exception {
        Class<?>[] params = new Class<?>[]{String.class};
        Method found = ReflectiveBridge.findMethod(SampleTarget.class, "echo", params);
        assertNotNull(found);
        // Mutating caller's array after lookup must not affect cached lookup under original signature
        params[0] = Integer.class;
        Method stillFound = ReflectiveBridge.findMethod(SampleTarget.class, "echo", new Class<?>[]{String.class});
        assertEquals(found, stillFound);
    }

    @Test
    public void annotationFormatterHandlesSurrogatesAndCapsLongMembers() throws Exception {
        Method m = SampleTarget.class.getMethod("annotated");
        BigAnn big = m.getAnnotation(BigAnn.class);
        String formatted = AnnotationFormatter.annotation(big);
        assertTrue(formatted.contains("a=\"alpha\""));
        assertTrue(formatted.contains("b=\"beta\""));

        // Long annotation truncation never breaks UTF-16 surrogate pairs
        HighSurrogateAnn emoji = m.getAnnotation(HighSurrogateAnn.class);
        String s = AnnotationFormatter.annotation(emoji);
        assertTrue(s.contains("😀"));
        assertFalse(Character.isHighSurrogate(s.charAt(s.length() - 1)));
    }
}
