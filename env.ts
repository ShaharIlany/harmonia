/**
 * A setting from the environment: HARMONIA_<NAME>, or TEAM_CHAT_<NAME> from before the app was renamed.
 * Not called `env`: functions here keep their own `env` for child processes, and a local of that name would hide it.
 */
export const setting = (name: string): string | undefined => process.env[`HARMONIA_${name}`] ?? process.env[`TEAM_CHAT_${name}`];
