# Why add a merge-loss audit to your repository

## The problem

When someone merges one branch into another and resolves conflicts by hand, they can accidentally revert other people's work — most commonly by keeping their whole version of a file, which throws away changes in regions of the file that were never in conflict. Git records whatever resolution they commit, with no distinction between "what the merge algorithm produced" and "what the human changed afterwards."

This class of error is uniquely invisible. The lost content doesn't appear in the pull request's "files changed" view, or appears buried in a list of hundreds of incidentally-touched files that no reviewer can realistically audit. Standard forensics miss it too: `git log -S` and `git blame` skip merge commits by default, so even when someone later notices content is gone, the search for *when* and *who* comes up empty. Worse, the blame usually lands on the wrong person — whoever's later, entirely innocent merge first makes the absence visible in a diff.

Any repository where humans (or, increasingly, coding agents) resolve merge conflicts has this exposure. That includes every workflow where contributors maintain local clones and pull with divergence — regardless of whether the project merges PRs by merge commit, squash, or rebase.

## A real incident

In HL7/fhir, a validation invariant (qrs-4, FHIR-55973) was added to the QuestionnaireResponse resource in April 2026. In June, a routine "merge master into my branch" commit silently reverted it — the file wasn't even listed as conflicted in the merge. The loss rode into master inside an unrelated PR, went unnoticed for two months, and was eventually blamed on the author of a *different* PR whose merge happened to make the absence visible. A retrospective audit of that repository found the same merge had silently reverted content in ~25 files, and found several additional losses from other merges, including one introduced by an AI coding agent resolving PR conflicts.

Every one of those losses was detectable, mechanically, on the day it happened.

## What the check does

Git 2.36 added `--remerge-diff`: for any merge commit, git redoes the merge mechanically and shows only what the *recorded* result changed beyond that. An empty result means the merge was exactly what the algorithm produced. A non-empty result is precisely the set of decisions the human made — a handful of lines, instead of a hundred-file merge diff.

The audit script (`tools/merge-audit.py`) runs this over a range of commits and classifies each deviation. Content dropped from a file that was **not** conflicted is flagged as a *silent drop* — nobody chose it, and it is almost always an accident. Content dropped during a genuine conflict resolution is listed for review with lower urgency. The accompanying GitHub Actions workflow runs the script on each push to the main branch, over just the newly pushed commits, and posts a warning and job summary when it finds a silent drop. It is advisory only — it never fails a build — and it also supports manual runs over a longer window as a periodic sweep.

For contributors, there is a one-line self-check before pushing any hand-resolved merge:

    git show --remerge-diff HEAD

If that shows anything you didn't consciously decide, the merge is wrong.

## The cost

Near zero. The CI job needs a full-history checkout and a few minutes of compute per push; the script has no dependencies beyond git ≥ 2.36 and python3. False positives are rare and self-explaining: deliberate resolutions show up with the commit that explains them, and are waived by reading the warning. There is nothing to configure beyond the path prefix that scopes which files matter (e.g. `source/`).

## Why this isn't already standard practice

`--remerge-diff` is recent (2022) and little-known, and no packaged CI action popularized it the way linters and secret-scanners were popularized. The failure mode is rare per-merge, invisible when it occurs, and expensive to diagnose months later — exactly the profile of a problem that never causes enough pain in any one place to produce standard tooling. That is an argument for adopting the check, not against it: the first time it fires, it will have paid for itself.

## Adoption

Copy `tools/merge-audit.py` into the repository, add the workflow as `.github/workflows/merge-audit.yml`, and set the `--path-prefix` argument to the directory tree whose content matters. For an initial baseline, run it once by hand over the repository's recent history (`python3 tools/merge-audit.py . --since <date>`) — it will tell you whether you already have losses you don't know about.
