// apps/ccaudit/src/cli/commands/install-skill.ts
//
// Gunshi subcommand: ccaudit install-skill
//
// Copies the bundled ccaudit-bust.md skill file into the user's Claude Code
// commands directory so they can invoke /ccaudit-bust from any session.
//
// Default target: ~/.claude/commands/ccaudit-bust.md  (global scope)
// With --project: ./.claude/commands/ccaudit-bust.md  (current project only)
//
// Output modes: rendered (default) / --quiet / --json.
// Exit ladder: 0 (success / dry-run / aborted), 1 (fs error / non-TTY conflict).

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { homedir } from 'node:os';
import { define } from 'gunshi';
import { initColor, colorize } from '@ccaudit/terminal';
import { outputArgs } from '../_shared-args.ts';
import { resolveOutputMode, buildJsonEnvelope } from '../_output-mode.ts';
import { CCAUDIT_BUST_SKILL_CONTENT } from './_skill-content.ts';

const SKILL_FILENAME = 'ccaudit-bust.md';

export const installSkillCommand = define({
  name: 'install-skill',
  description: `Install the /ccaudit-bust Claude Code skill to ~/.claude/commands/`,
  toKebab: true,
  renderHeader: null,
  args: {
    ...outputArgs,
    json: {
      type: 'boolean' as const,
      short: 'j',
      description: 'Output as JSON',
      default: false,
    },
    force: {
      type: 'boolean' as const,
      short: 'f',
      description: 'Overwrite existing skill file without prompting',
      default: false,
    },
    'dry-run': {
      type: 'boolean' as const,
      description: 'Show what would be installed without writing any files',
      default: false,
    },
    project: {
      type: 'boolean' as const,
      short: 'p',
      description: 'Install to .claude/commands/ in current directory (project scope)',
      default: false,
    },
  },
  async run(ctx) {
    initColor();
    const outMode = resolveOutputMode(ctx.values);
    const force = ctx.values.force === true;
    const dryRun = ctx.values['dry-run'] === true;
    const project = ctx.values.project === true;

    const targetDir = project
      ? path.join(process.cwd(), '.claude', 'commands')
      : path.join(homedir(), '.claude', 'commands');

    const targetFile = path.join(targetDir, SKILL_FILENAME);

    // -- dry-run: report what would happen, exit cleanly ----------------------
    if (dryRun) {
      const dirExists = await pathExists(targetDir);
      const fileExists = await pathExists(targetFile);

      if (outMode.json) {
        process.stdout.write(
          JSON.stringify(
            buildJsonEnvelope('install-skill', 'n/a', 0, {
              status: 'dry-run',
              target_file: targetFile,
              scope: project ? 'project' : 'global',
              dir_exists: dirExists,
              file_exists: fileExists,
              would_overwrite: fileExists,
            }),
          ) + '\n',
        );
      } else if (!outMode.quiet) {
        const lines: string[] = ['[dry-run] Would install to:', `  ${targetFile}`];
        if (!dirExists) {
          lines.push(`  (directory ${targetDir} would be created)`);
        }
        if (fileExists) {
          lines.push('  (file already exists — would overwrite)');
        }
        lines.push('', 'No files written. Re-run without --dry-run to install.');
        process.stdout.write(lines.join('\n') + '\n');
      }
      process.exit(0);
    }

    // -- check for existing file -----------------------------------------------
    const fileExists = await pathExists(targetFile);

    if (fileExists && !force) {
      if (process.stdout.isTTY) {
        const confirmed = await promptYesNo(`${targetFile} already exists. Overwrite? [y/N] `);
        if (!confirmed) {
          process.stdout.write('Aborted. Use --force to overwrite without prompting.\n');
          process.exit(0);
        }
      } else {
        // Non-TTY: cannot prompt; require explicit --force
        const msg = `${targetFile} already exists. Run with --force to overwrite.`;
        if (outMode.json) {
          process.stdout.write(
            JSON.stringify(
              buildJsonEnvelope('install-skill', 'n/a', 1, {
                status: 'error',
                error: msg,
              }),
            ) + '\n',
          );
        } else {
          process.stderr.write(msg + '\n');
        }
        process.exit(1);
      }
    }

    // -- create directory if needed -------------------------------------------
    try {
      await mkdir(targetDir, { recursive: true, mode: 0o755 });
    } catch (err) {
      const msg = `Could not create directory ${targetDir}: ${errMsg(err)}`;
      if (outMode.json) {
        process.stdout.write(
          JSON.stringify(
            buildJsonEnvelope('install-skill', 'n/a', 1, {
              status: 'error',
              error: msg,
            }),
          ) + '\n',
        );
      } else {
        process.stderr.write(msg + '\n');
      }
      process.exit(1);
    }

    // -- write skill file ------------------------------------------------------
    try {
      await writeFile(targetFile, CCAUDIT_BUST_SKILL_CONTENT, 'utf8');
    } catch (err) {
      const msg = `Could not write ${targetFile}: ${errMsg(err)}`;
      if (outMode.json) {
        process.stdout.write(
          JSON.stringify(
            buildJsonEnvelope('install-skill', 'n/a', 1, {
              status: 'error',
              error: msg,
            }),
          ) + '\n',
        );
      } else {
        process.stderr.write(msg + '\n');
      }
      process.exit(1);
    }

    // -- success output --------------------------------------------------------
    if (outMode.json) {
      process.stdout.write(
        JSON.stringify(
          buildJsonEnvelope('install-skill', 'n/a', 0, {
            status: fileExists ? 'updated' : 'installed',
            target_file: targetFile,
            scope: project ? 'project' : 'global',
          }),
        ) + '\n',
      );
    } else if (!outMode.quiet) {
      const verb = fileExists
        ? 'Skill updated (overwrite):'
        : project
          ? 'Skill installed (project scope):'
          : 'Skill installed:';
      const lines: string[] = [
        colorize.green(`\u2713 ${verb}`),
        `  ${targetFile}`,
        '',
        project
          ? 'Use it in Claude Code sessions opened in this directory:'
          : 'Use it in any Claude Code session:',
        '  /ccaudit-bust',
      ];
      if (!project && !fileExists) {
        lines.push(
          '',
          'The skill audits your ghost inventory and archives agents and skills you select in plain English.',
          'Nothing is modified without your explicit approval.',
          '',
          'To refresh after a ccaudit update:',
          '  npx ccaudit@latest install-skill --force',
          '',
          'To undo anything the skill does later:',
          '  npx ccaudit@latest restore',
        );
      }
      process.stdout.write(lines.join('\n') + '\n');
    }

    process.exit(0);
  },
});

// -- Helpers -------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// -- In-source tests -----------------------------------------------------------

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe('installSkillCommand', () => {
    it('is defined with correct name', () => {
      expect(installSkillCommand.name).toBe('install-skill');
    });

    it('has force, dry-run, and project flags', () => {
      const args = installSkillCommand.args as Record<string, unknown>;
      expect(args).toHaveProperty('force');
      expect(args).toHaveProperty('dry-run');
      expect(args).toHaveProperty('project');
    });
  });

  describe('CCAUDIT_BUST_SKILL_CONTENT', () => {
    it('is a non-empty string', () => {
      expect(typeof CCAUDIT_BUST_SKILL_CONTENT).toBe('string');
      expect(CCAUDIT_BUST_SKILL_CONTENT.length).toBeGreaterThan(100);
    });

    it('contains the skill title', () => {
      expect(CCAUDIT_BUST_SKILL_CONTENT).toContain('ccaudit-bust');
    });

    it('references the ghost --json audit command', () => {
      expect(CCAUDIT_BUST_SKILL_CONTENT).toContain('ghost --json');
    });
  });
}
