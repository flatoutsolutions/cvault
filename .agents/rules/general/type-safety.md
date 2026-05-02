---
trigger: always_on
---

# Type Safety Requirements

TypeScript's type system is a safety net. Do NOT undermine it. Every `as any` is a hole in the net.

## Strict Rules

- **NEVER use `as any`** to silence the compiler. If the type system is complaining, fix the types — don't muzzle the error.
- **NEVER use `(obj as any).field`** to access a field that isn't on the type. If the field should exist, add it to the type definition. If it's optional, make it `optional` in the type.
- **NEVER use `@ts-ignore` or `@ts-expect-error`** unless there is a documented, unavoidable reason (e.g., a known bug in a third-party library's type definitions). In that case, add a comment explaining WHY the suppression is necessary and link to the issue tracker.

## Type Definitions

- All data structures, state objects, and API payloads MUST have explicit TypeScript types or interfaces — not `Record<string, any>` or untyped objects.
- When adding a new field to a persisted data structure (database document, state object saved to DB), update the corresponding type definition FIRST. The type is the source of truth; the runtime code follows.
- Convex schema validators and TypeScript types must stay in sync. If you add a field to the schema, add it to the type. If you add a field to the type, add it to the schema.

## Function Signatures

- All exported functions MUST have explicit parameter types and return types. Do NOT rely on type inference for public APIs.
- Use `Id<"tableName">` for Convex document IDs, not `string`.
- Use specific union types for string literals (`"active" | "inactive"`) instead of `string` wherever the set of valid values is known.

## Narrowing and Guards

- Use type narrowing (`if`, `in`, type guards) instead of type assertions (`as`).
- When dealing with data from external sources (API responses, DB reads of untyped fields), validate and narrow the types at the boundary. Do not let `unknown` or `any` leak into business logic.

## When `as` Is Acceptable

The only legitimate uses of type assertions:

1. **`as const`** — for literal types. Always encouraged.
2. **`as Type` after validation** — e.g., after a runtime check that guarantees the type is correct: `if (isString(x)) return x as string`. Prefer type guards instead when possible.
3. **Test code** — test files have slightly more leeway for casting test fixtures, but still prefer properly typed test data.
