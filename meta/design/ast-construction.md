# Constructing AST

## Summary

Rolldown synthesizes oxc AST nodes in many places — module finalizers, the scanner's pre-processing, HMR, and plugins. Historically it did so through several competing idioms (a hand-maintained `AstSnippet` facade, raw `oxc::ast::AstBuilder`, construction-flavored extension traits, and `..Foo::dummy(alloc)` struct-update literals). oxc has since made `AstBuilder` the single sanctioned construction path (`#[non_exhaustive]` on every `NodeId`-bearing node, oxc 0.135 / [oxc#23046](https://github.com/oxc-project/oxc/pull/23046)), which deleted the struct-literal idiom outright.

Going forward rolldown standardizes on **oxc's `AstBuilder` as the construction API**, and expresses its own recurring constructions as an **`AstBuilderExt` extension trait** whose methods are prefixed `make_`. This document records that decision and the reasoning, so future work (and the upcoming oxc `AstBuilder` redesign, [oxc#23043](https://github.com/oxc-project/oxc/issues/23043)) has a baseline.

## Current state

Before this convention, the same kind of node could be built four different ways, and the entry points overlapped:

- **`AstSnippet`** (`crates/rolldown_ecmascript_utils/src/ast_snippet.rs`, ~1030 lines, ~50 methods). A wrapper around `AstBuilder` that mixes two unrelated jobs: thin renames of single `AstBuilder` calls (`id_ref_expr`, the `call_expr_with_*` family, `string_literal_expr`, …) and genuine multi-node rolldown patterns (`wrap_with_to_esm`, `commonjs_wrapper_stmt`, the `.then` chains). Its naming is sprawling and undiscoverable — the call-expression family alone encodes arg-count/return-shape into a suffix matrix (`call_expr_with_arg_expr` vs `_with_arg_expr_expr` vs `_with_2arg_expr_expr` …). The author already flagged the type name as a compromise:

  ```rust
  // crates/rolldown_ecmascript_utils/src/ast_snippet.rs
  // `AstBuilder` is more suitable name, but it's already used in oxc.
  pub struct AstSnippet<'ast> {
    pub builder: AstBuilder<'ast>,
  }
  ```

- **The `pub builder` escape hatch.** Because `AstSnippet::builder` is public, roughly half of all AstSnippet interactions bypass the helpers and reach straight through to raw `AstBuilder` (~219 `snippet.builder.*` call sites vs. ~196 named-helper calls). The facade coexists with the thing it wraps instead of encapsulating it.

- **Ad-hoc `AstBuilder` access.** Construction-flavored extension traits (`crates/rolldown_ecmascript_utils/src/extensions/ast_ext/`) that only receive `&Allocator` build a fresh `AstBuilder::new(alloc)` inline — a third way to obtain a builder, alongside `self.ast`-style fields and `snippet.builder`.

- **`..Foo::dummy(alloc)` struct-update literals.** Previously the most direct way to spell a node. oxc 0.135's `#[non_exhaustive]` makes this uncompilable for any `NodeId`-bearing node; [#9670](https://github.com/rolldown/rolldown/pull/9670) migrated the ~26 affected sites (in `module_finalizers/` and the `ast_ext` traits) onto `AstBuilder` constructors. The remaining `::dummy()` sites are on non-node types (options/config) and are unaffected.

- **Parse-from-source-string.** Not all AST is built — some is authored as JS source and parsed via `EcmaCompiler::parse` (`crates/rolldown_ecmascript/src/ecma_compiler.rs`), which parses a source string into a standalone `EcmaAst` with its own allocator. On the output side this is essentially just the runtime module (`crates/rolldown/src/module_loader/runtime_module_task.rs:226`). The ~35 direct oxc `Parser::new` sites in plugins and scanner sub-analyzers parse *input* source to analyze or transform it — a different activity from constructing rolldown's own AST.

Two facts constrain every choice and are documented in [ast-mutation](./ast-mutation.md): synthesized nodes must carry a synthetic span (the reserved `SPAN`, `0..0`) so they don't false-match the span-keyed side tables (see `crates/rolldown/src/module_finalizers/mod.rs:1088`), and rolldown does not re-run semantic after finalize, so synthesized nodes keep a dummy `NodeId` for life rather than being backfilled.

## The convention

Pick the tool by what you are building:

### Generic nodes → oxc's `AstBuilder` directly

Name the handle `ast` (matching oxc's own convention, e.g. `self.ast: AstBuilder`). The thin `AstSnippet` renames collapse to their oxc equivalents:

```rust
// before: a renamed single-call wrapper
let member = self.snippet.builder.alloc_static_member_expression(SPAN, object, property, false);

// after: the same oxc call, reached through the `ast` handle
let member = ast.alloc_static_member_expression(SPAN, object, property, false);
```

Don't `AstBuilder::new(alloc)` ad hoc when a handle is already in scope, and don't reach for raw `oxc::allocator::Vec` / `Box` when the builder already offers `ast.vec*` / `ast.alloc_*`. oxc's constructors are positional; preface a verbose chunk with a comment showing the JS it produces, as oxc itself recommends.

### Rolldown-specific patterns → `AstBuilderExt` with a `make_` prefix

For constructions that compose several nodes into a recurring rolldown convention (CJS/ESM interop wrappers, `__toESM` / `__toCommonJS` calls, `.then` chains, …), add a method to an `AstBuilderExt` extension trait implemented on oxc's `AstBuilder`, rather than a separate wrapper type:

```rust
pub trait AstBuilderExt<'ast> {
  fn make_to_esm_wrapper(self, namespace: Expression<'ast>) -> Expression<'ast>;
  fn make_commonjs_wrapper(self, /* ... */) -> Statement<'ast>;
  // ...
}

impl<'ast> AstBuilderExt<'ast> for AstBuilder<'ast> { /* ... */ }
```

These methods:

- are prefixed **`make_`** and named after the **operation** (`make_to_esm_wrapper`), never after a bare AST node;
- mirror oxc's builder signature style: `span` first, positional args, `make_<x>` returns a value and `make_alloc_<x>` returns a boxed node.

A method earns a place here only if it encodes a multi-step rolldown convention that is wrong-by-default when open-coded — not merely to shorten one `AstBuilder` call.

### Build programmatically by default; parsing source is an exception

Construct nodes with `AstBuilder` / `AstBuilderExt`. This is the default for **all** node construction, including code rolldown emits, because direct construction has no runtime cost whereas parsing a source string pays lexing + parsing overhead on every build.

Authoring code as JS source and parsing it (`EcmaCompiler::parse`) is reserved for a large, fixed body of code where maintaining it as real JS clearly outweighs the one-time parse cost. In practice that is the **runtime module** (`crates/rolldown/src/module_loader/runtime_module_task.rs:226`) and essentially nothing else on the output side — treat it as a special case, not a tool to reach for. Never parse for nodes that splice into an existing AST and need a synthetic `SPAN` + dummy `NodeId` — build those programmatically, per the constraint above.

### Read-only inspection → `as_*` / `is_*`

Keep read-only inspection helpers separate from construction; they are not part of `AstBuilderExt`.

## Why `make_` + operation names

The prefix is not decoration — it does two jobs:

- **Every call site self-identifies.** A bare node name (`ast.call_expression(..)`) is oxc; a `make_*` name (`ast.make_to_esm_wrapper(..)`) is a rolldown extension. There is no way to mark a trait-method call differently from an inherent-method call in Rust syntax, so the distinction is carried by naming: oxc methods are named after the node they produce (nouns), rolldown's after the operation they perform (verbs).
- **It prevents silent shadowing.** Rust method resolution prefers inherent methods over trait methods. If a future oxc release adds an inherent method whose name collides with an `AstBuilderExt` method, ours would be silently shadowed. Keeping the `make_` prefix (and never naming an extension method after a bare node) guarantees no collision.

Naming the handle `ast` matches oxc's own code, so oxc calls and rolldown extension calls read uniformly when interleaved.

## Forward compatibility with oxc's `AstBuilder` redesign

oxc#23043 will move construction from `builder.alloc_foo(span, …)` to per-type constructors that take the generator last (`Foo::boxed(span, …, gen)`), unify them behind an `AstGenerator` trait, and make `NodeId` assignment automatic and impossible to forget — explicitly citing rolldown [#9609](https://github.com/rolldown/rolldown/pull/9609) as motivation. Standardizing on a single `AstBuilder` handle now means that redesign drops in with minimal churn, and `AstBuilderExt` can become generic over `AstGenerator` rather than tied to today's `AstBuilder`. The verbosity of positional arguments is the one ergonomic problem oxc's redesign does **not** solve, which is why a thin local extension layer (kept to genuine rolldown patterns) is justified — but it stays small and aligned with oxc's style rather than diverging into its own taxonomy.

## Migration

This is an incremental convention, not a big-bang refactor:

- `AstSnippet` dissolves over time: thin renames inline to the `ast` handle; genuine patterns move to `AstBuilderExt`. The type's awkward name disappears with it (the role it kept — rolldown-specific construction — now lives on oxc's actual `AstBuilder`).
- New code follows the convention immediately; existing sites are migrated opportunistically (the `..::dummy()` cluster was already forced over by #9670).

## Plan

> **Temporary section — delete once the migration below is complete.** It tracks the concrete moves and exists only while the work is in flight.

First, what this does **not** touch, to head off a likely assumption:

- The `..Foo::dummy(alloc)` AST struct-spread idiom is **not** part of this work. oxc 0.135's `#[non_exhaustive]` already forces it out, and [#9670](https://github.com/rolldown/rolldown/pull/9670) migrated the ~26 affected sites (in `module_finalizers/` and the `ast_ext` traits) onto `AstBuilder`, dropping their `Dummy as _` imports.
- rolldown defines **no `Dummy` impls of its own**, so there is nothing rolldown-maintained to delete there. The surviving `::dummy()` calls — `RuntimeModuleBrief::dummy()` (`crates/rolldown_common/src/module_loader/runtime_module_brief.rs:69`) and `rolldown_devtools::Session::dummy()` (`crates/rolldown_devtools/src/init_tracing.rs:69`, 3 call sites) — are inherent domain placeholders unrelated to AST construction. **Leave them.**

What the convention drives, all centered on `AstSnippet` (`crates/rolldown_ecmascript_utils/src/ast_snippet.rs`):

1. **Add `AstBuilderExt`** (trait + `impl AstBuilderExt for AstBuilder`). Move the genuine multi-node patterns onto it, renamed `make_` + operation: e.g. `wrap_with_to_esm` → `make_to_esm_wrapper`, `commonjs_wrapper_stmt`/`esm_wrapper_stmt` → `make_commonjs_wrapper`/`make_esm_wrapper`, `re_export_call_expr`, `keep_name_call_expr`, the `promise_resolve_then_*` / `then_*` chains.
2. **Delete the thin wrappers** (~half of the ~50 methods) by inlining them to their oxc `AstBuilder` equivalent at each call site: the `call_expr_with_arg_expr*` / `_2arg_*` suffix matrix, `id_ref_expr` (~42 sites), `string_literal_expr`, `number_expr`, `void_zero`, `alloc_string_literal`, the `alloc_simple_call_expr` re-wraps, etc.
3. **Retire the `AstSnippet` type and its `pub builder` escape hatch.** The ~219 `snippet.builder.*` reach-throughs become direct calls on an `ast: AstBuilder` handle, threaded the same way `AstSnippet` is today; rename the handle to `ast`. Drop the `AstSnippet` re-export from `crates/rolldown_ecmascript_utils/src/lib.rs`, and with it the `// `AstBuilder` is more suitable name…` comment.
4. **Collapse ad-hoc builder access.** Construction ext traits that currently do `AstBuilder::new(alloc)` internally take/derive the shared `ast` handle instead.
5. **Separate read-only inspection.** Keep the `as_*` / `is_*` ext traits, but move them out of any module that, post-migration, holds only construction.

Rough order, each step compiling on its own: (1) land `AstBuilderExt` with the kept patterns → (2) migrate call sites off the named thin wrappers and off `snippet.builder` onto the `ast` handle → (3) delete the emptied `AstSnippet`.

## Related

- [ast-mutation](./ast-mutation.md) — the span/`NodeId`-as-identity contract that constrains synthesized nodes
- [runtime-helpers](./runtime-helpers.md) — the runtime functions that `make_*` interop constructors emit calls to
