import {
  compileTemplate, createJaxRsMatcher,
  type Matcher as GenericMatcher, type RouteMatch as GenericRouteMatch,
} from '../lib/jaxrs-router/routes';
import type { Index, Operation, Summary } from './types';

export type RouteMatch = GenericRouteMatch<Operation>;
export type Matcher = GenericMatcher<Operation>;
export { compileTemplate };

/** Builds a JAX-RS URL matcher across all modules and operations in a RAB catalog snapshot. */
export function createMatcher(summary: Summary, index: Index): Matcher {
  return createJaxRsMatcher(summary.baseUrl, summary.modules, index.operations, '/rest/');
}
