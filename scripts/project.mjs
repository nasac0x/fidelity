#!/usr/bin/env node
// PROJECT — per-project git: init once, checkpoint before a risky cycle, roll back
// instead of hand-reverting files.
//
//   node project.mjs init       --dir <project> [--message "chore: initial"]
//   node project.mjs status     --dir <project>
//   node project.mjs commit     --dir <project> --message "fix: hero spacing"
//   node project.mjs checkpoint --dir <project> --name cycle-2
//   node project.mjs rollback   --dir <project> --to fidelity/cycle-1 --yes
import path from 'node:path';
import { parseArgs, str, flag, usage, summary, rel, ensureDir } from './lib/core.mjs';
import * as git from './lib/git.mjs';

const A = parseArgs();
const cmd = String(A._[0] ?? 'status');
const dir = path.resolve(str(A.dir, '.'));

switch (cmd) {
  case 'init': {
    ensureDir(dir);
    const r = git.init(dir, { commitMessage: str(A.message, 'chore: initial') });
    summary('project-init', { ok: r.ok, dir: rel(dir, process.cwd()), created: r.created, commit: r.commit, files: r.files, skipped: r.skipped, reason: r.reason, error: r.error });
    process.exit(r.ok ? 0 : 1);
  }
  case 'commit': {
    const r = git.commitAll(dir, str(A.message, 'chore: fidelity cycle'));
    summary('project-commit', { ok: !r.error, ...r });
    process.exit(r.error ? 1 : 0);
  }
  case 'checkpoint': {
    const r = git.checkpoint(dir, str(A.name, `cycle-${Date.now()}`));
    summary('project-checkpoint', { ok: !r.error, ...r });
    process.exit(r.error ? 1 : 0);
  }
  case 'rollback': {
    if (!flag(A.yes)) {
      summary('project-rollback', { ok: false, reason: 'refusing without --yes: this discards uncommitted work' });
      process.exit(2);
    }
    const r = git.rollback(dir, str(A.to, 'HEAD'));
    summary('project-rollback', { ...r, dir: rel(dir, process.cwd()) });
    process.exit(r.ok ? 0 : 1);
  }
  case 'status': {
    const r = git.status(dir);
    summary('project-status', { ...r, dir: rel(dir, process.cwd()) });
    process.exit(r.ok ? 0 : 1);
  }
  default:
    usage('project.mjs <init|commit|checkpoint|rollback|status> --dir <project> [--message m] [--name n] [--to ref --yes]');
}
