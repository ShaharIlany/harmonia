/** A setting from the environment: HARMONIA_<NAME>, or TEAM_CHAT_<NAME> from before the app was renamed. */
export const env = (name: string): string | undefined => process.env[`HARMONIA_${name}`] ?? process.env[`TEAM_CHAT_${name}`];
