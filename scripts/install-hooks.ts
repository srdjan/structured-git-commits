/**
 * Git Hook Installer for Structured Commits
 *
 * Installs the commit-msg validation hook into the local or global git
 * hooks directory. Detects existing hooks and chains them.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run scripts/install-hooks.ts [options]
 *
 * Options:
 *   --global    Install to global hooks path (core.hooksPath)
 *   --uninstall Remove the installed hook
 */

const HOOK_SHIM = `#!/bin/sh
# Structured Git Commits - commit-msg hook
# Validates commit messages against the structured commits specification.
# Installed by: deno task hook:install

# If there's an original hook, run it first
if [ -x "$0.original" ]; then
  "$0.original" "$@"
  status=$?
  if [ $status -ne 0 ]; then
    exit $status
  fi
fi

# Run the structured commit validator
deno run --allow-read "$(dirname "$0")/../../scripts/validate-commit.ts" "$1"
`;

const GLOBAL_HOOK_SHIM = `#!/bin/sh
# Structured Git Commits - commit-msg hook (global)
# Validates commit messages against the structured commits specification.
# Installed by: deno task hook:install --global

# If there's an original hook, run it first
if [ -x "$0.original" ]; then
  "$0.original" "$@"
  status=$?
  if [ $status -ne 0 ]; then
    exit $status
  fi
fi

# Find the skill directory (where install-hooks.ts lives)
SKILL_DIR="SKILL_DIR_PLACEHOLDER"
deno run --allow-read "$SKILL_DIR/scripts/validate-commit.ts" "$1"
`;

const getLocalHooksDir = async (): Promise<string | null> => {
  try {
    const command = new Deno.Command("git", {
      args: ["rev-parse", "--git-dir"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    if (!output.success) return null;
    const gitDir = new TextDecoder().decode(output.stdout).trim();
    return `${gitDir}/hooks`;
  } catch {
    return null;
  }
};

const getGlobalHooksDir = async (): Promise<string | null> => {
  try {
    const command = new Deno.Command("git", {
      args: ["config", "--global", "core.hooksPath"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    if (!output.success) return null;
    return new TextDecoder().decode(output.stdout).trim() || null;
  } catch {
    return null;
  }
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

const installHook = async (
  hooksDir: string,
  shimContent: string,
): Promise<void> => {
  const hookPath = `${hooksDir}/commit-msg`;

  // Ensure hooks directory exists
  await Deno.mkdir(hooksDir, { recursive: true });

  // If existing hook, back it up
  if (await fileExists(hookPath)) {
    const existing = await Deno.readTextFile(hookPath);
    if (existing.includes("Structured Git Commits")) {
      console.log("Hook already installed. Reinstalling.");
    } else {
      const backupPath = `${hookPath}.original`;
      if (await fileExists(backupPath)) {
        console.error(
          `Existing hook backup found at ${backupPath}. Remove it first or uninstall.`,
        );
        Deno.exit(1);
      }
      await Deno.rename(hookPath, backupPath);
      console.log(`Existing hook backed up to ${backupPath}`);
    }
  }

  await Deno.writeTextFile(hookPath, shimContent);
  await Deno.chmod(hookPath, 0o755);
  console.log(`Hook installed at ${hookPath}`);
};

const uninstallHook = async (hooksDir: string): Promise<void> => {
  const hookPath = `${hooksDir}/commit-msg`;
  const backupPath = `${hookPath}.original`;

  if (!(await fileExists(hookPath))) {
    console.log("No hook found to uninstall.");
    return;
  }

  const content = await Deno.readTextFile(hookPath);
  if (!content.includes("Structured Git Commits")) {
    console.error("Hook at", hookPath, "was not installed by this tool.");
    Deno.exit(1);
  }

  await Deno.remove(hookPath);

  if (await fileExists(backupPath)) {
    await Deno.rename(backupPath, hookPath);
    console.log("Original hook restored from backup.");
  }

  console.log("Hook uninstalled.");
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const args = Deno.args;
  const isGlobal = args.includes("--global");
  const isUninstall = args.includes("--uninstall");

  if (isGlobal) {
    let hooksDir = await getGlobalHooksDir();
    if (!hooksDir) {
      const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
      hooksDir = `${home}/.config/git/hooks`;
      console.log(`No global hooks path configured. Using ${hooksDir}`);

      // Set the global hooks path
      const command = new Deno.Command("git", {
        args: ["config", "--global", "core.hooksPath", hooksDir],
      });
      await command.output();
    }

    if (isUninstall) {
      await uninstallHook(hooksDir);
    } else {
      // Resolve the skill directory for the global shim
      const scriptDir = new URL(".", import.meta.url).pathname;
      const skillDir = scriptDir.replace(/\/scripts\/$/, "");
      const shim = GLOBAL_HOOK_SHIM.replace("SKILL_DIR_PLACEHOLDER", skillDir);
      await installHook(hooksDir, shim);
    }
  } else {
    const hooksDir = await getLocalHooksDir();
    if (!hooksDir) {
      console.error("Not in a git repository. Run from a git repo or use --global.");
      Deno.exit(1);
    }

    if (isUninstall) {
      await uninstallHook(hooksDir);
    } else {
      await installHook(hooksDir, HOOK_SHIM);
    }
  }
};

main();
