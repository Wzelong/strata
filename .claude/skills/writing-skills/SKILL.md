---
name: writing-skills
description: Guidelines for authoring Claude Skills (SKILL.md files) that Claude can discover and use effectively. Use when creating a new Skill or refining an existing one.
---

# Writing effective Skills

A Skill is a markdown file (`SKILL.md`) with YAML frontmatter that gives Claude reusable domain knowledge or workflows. Apply these guidelines when creating or refining Skills.

## Frontmatter requirements

```yaml
---
name: my-skill-name         # lowercase, hyphens only, ≤64 chars
description: What it does and when to use it. Third-person only.  # ≤1024 chars
---
```

**The description is the most important field** — Claude uses it to pick your Skill from potentially 100+ available Skills. It must include:
1. **What** the Skill does
2. **When** to use it (specific triggers, keywords, contexts)

Write in **third person**. Not "I can help..." or "You can use this...". Just "Processes X. Use when..."

Good: `Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.`

Bad: `Helps with documents` (vague, no trigger)

## Naming

Use gerund form (verb+ing): `processing-pdfs`, `writing-prompts`, `managing-database`. Alternatives: noun phrases (`pdf-processing`) or action verbs (`process-pdfs`). Avoid vague names (`helper`, `utils`, `tools`).

## Core principle: be concise

Claude is already smart. For every piece of content, ask:
- Does Claude already know this?
- Does this token earn its place?
- Can I remove this and still get the right behavior?

**Good** (~50 tokens):
````markdown
## Extract PDF text
Use pdfplumber:
```python
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
````

**Bad** (~150 tokens): Explains what PDFs are, why pdfplumber, how pip works, etc. The model knows all of that.

Keep SKILL.md body under **500 lines**. If you're approaching the limit, split into reference files.

## Degrees of freedom

Match specificity to task fragility:

| Task type | Approach | Example |
|-----------|----------|---------|
| Many valid approaches, context-dependent | High freedom, plain instructions | "Review code for bugs, readability, convention adherence" |
| Preferred pattern exists, some variation OK | Medium freedom, pseudocode/templates | "Use this function signature, customize body as needed" |
| Fragile, consistency critical | Low freedom, exact commands | "Run exactly: `python scripts/migrate.py --verify --backup`" |

Think of a robot on a path: narrow bridge with cliffs → exact instructions. Open field → general direction.

## Progressive disclosure

SKILL.md is a table of contents, not the whole manual. Point Claude to deeper content only when needed:

```markdown
# PDF Processing

## Quick start
[inline instructions for common case]

## Advanced
**Form filling**: See [forms.md](forms.md)
**API reference**: See [reference.md](reference.md)
```

Claude reads `forms.md` only when the task requires it — zero token cost until accessed.

**Keep references one level deep.** If `SKILL.md → advanced.md → details.md`, Claude may only partially read nested files.

**For reference files >100 lines**, include a table of contents at the top so Claude can preview the structure.

## Workflows and feedback loops

For complex tasks, provide explicit checklists Claude can track:

```markdown
## Form filling workflow

Copy this checklist:
- [ ] Step 1: Analyze the form
- [ ] Step 2: Create field mapping
- [ ] Step 3: Validate mapping
- [ ] Step 4: Fill the form
- [ ] Step 5: Verify output
```

For quality-critical tasks, build in validation loops:
```
1. Make edits
2. Validate (run script / check against reference)
3. If fails: review error → fix → re-validate
4. Only proceed when validation passes
```

## Scripts and code

When including utility scripts:
- **Handle errors explicitly** — don't punt to Claude with vague failures
- **Justify constants** — no `TIMEOUT = 47` without a comment explaining why
- **Make execution intent clear**: "Run `analyze.py`" (execute) vs "See `analyze.py` for the algorithm" (read)
- **Use forward slashes** in paths (`scripts/helper.py`), not backslashes

Scripts are preferred over inline code when:
- Reliability matters (pre-tested code beats regenerated code)
- Used across multiple Skill invocations
- Complex logic that would bloat SKILL.md

## Content to avoid

**Time-sensitive information** that will expire:
- Bad: "Before August 2025, use the old API. After, use the new API."
- Good: Main section describes current method. Deprecated patterns go in a collapsed "Legacy" section.

**Inconsistent terminology** — pick one term and stick with it throughout. Don't mix "field/box/element" or "extract/pull/get/retrieve".

**Too many options** — pick a default:
- Bad: "Use pypdf, or pdfplumber, or PyMuPDF, or..."
- Good: "Use pdfplumber. For scanned PDFs, use pdf2image + pytesseract."

## Iteration loop

**Build evals before documentation.** Identify specific failures Claude makes without the Skill, then write the minimum content that fixes those failures.

**Hierarchical authoring**:
1. Work with Claude A (authoring) to draft the Skill
2. Test the Skill with Claude B (a fresh instance using it)
3. Observe where Claude B struggles or misses content
4. Return to Claude A with specific feedback: "Claude B forgot to filter test accounts. Is this rule prominent enough?"
5. Refine and re-test

Watch for:
- **Ignored sections** — remove or signal them better
- **Repeated re-reads** of one file — move that content into SKILL.md itself
- **Missed references** — make links more explicit

## Anti-patterns

- **Windows paths** (`scripts\helper.py`) — use forward slashes
- **Deeply nested references** — keep one level from SKILL.md
- **Kitchen sink SKILL.md** — split into reference files once past ~500 lines
- **Vague descriptions** — no "helps with documents" or "does stuff with files"
- **First/second person** — no "I can..." or "you can..." in descriptions

## Checklist

Core:
- [ ] Description is specific, third-person, includes what + when
- [ ] Name uses gerund form, lowercase, hyphens only
- [ ] SKILL.md body under 500 lines
- [ ] No time-sensitive info (or in collapsed legacy section)
- [ ] Consistent terminology throughout
- [ ] Examples are concrete, not abstract
- [ ] File references are one level deep
- [ ] Reference files >100 lines have a TOC

Scripts (if present):
- [ ] Explicit error handling, no punts
- [ ] All constants justified
- [ ] Execution vs read-as-reference clearly stated
- [ ] Forward slashes in all paths
- [ ] Dependencies listed

Testing:
- [ ] At least 3 evaluations covering real use cases
- [ ] Tested with Claude Haiku/Sonnet/Opus (if used across tiers)
- [ ] Observed Claude B using the Skill, iterated based on behavior
