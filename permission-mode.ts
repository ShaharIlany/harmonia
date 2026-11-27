// The permission mode a channel's runs get when it has no choice of its own. Kept apart from team.ts so the sandbox
// and settings it depends on are named in one place.
import { SETTINGS } from "./paths";
import { PERMISSION_MODES, type Channel, type PermissionMode } from "./store";
import { sandboxActive } from "./sandbox";

/** What a channel without its own choice gets: settings.json "permissionMode", else bypass where the sandbox guards the run, else edits only. */
export const defaultPermissionMode = (): PermissionMode =>
  PERMISSION_MODES.includes(SETTINGS.permissionMode) ? SETTINGS.permissionMode : sandboxActive() ? "bypass" : "acceptEdits";
export const permissionModeOf = (ch: Channel): PermissionMode => ch.permissionMode ?? defaultPermissionMode();
